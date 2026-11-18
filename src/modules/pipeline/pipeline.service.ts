import { ImageVariant, PipelineJob } from '../../db/models/index.js';
import { sequelize } from '../../db/sequelize.js';
import { VARIANT_KINDS } from '../../config/pipeline.js';
import { enqueuePipelineStage } from '../../integrations/queue.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { publishImageEvent } from '../images/image-events.js';
import { toImageDto } from '../images/images.dto.js';
import { findOwnedImage } from '../images/images.service.js';
import {
  toPipelineDto,
  toPipelineSummary,
  toVariantDto,
  type PipelineDto,
  type PipelineSummaryDto,
  type VariantDto,
} from './pipeline.dto.js';

export interface VariantList extends PipelineSummaryDto {
  variants: VariantDto[];
}

/** Clears everything a run writes, for the start of a new run. */
const FRESH_RUN = {
  status: 'queued',
  failedStage: null,
  errorCode: null,
  errorMessage: null,
  sourceFormat: null,
  width: null,
  height: null,
  originalBytes: null,
  convertedBytes: null,
  compressedBytes: null,
  compressionRatio: null,
  jpegQuality: null,
  conversionStartedAt: null,
  convertedAt: null,
  compressionStartedAt: null,
  compressedAt: null,
  variantsStartedAt: null,
  completedAt: null,
  failedAt: null,
} as const;

async function ownedJob(userId: string, imageId: string): Promise<PipelineJob> {
  const image = await findOwnedImage(userId, imageId);
  const job = await PipelineJob.findOne({ where: { imageId: image.id } });
  if (!job) throw Errors.notFound('Processing job');
  return job;
}

export const pipelineService = {
  async get(userId: string, imageId: string): Promise<PipelineDto> {
    return toPipelineDto(await ownedJob(userId, imageId));
  },

  /** The stored variants. During a reprocess these are the previous run's until the new run finishes. */
  async variants(userId: string, imageId: string): Promise<VariantList> {
    const job = await ownedJob(userId, imageId);
    const rows = await ImageVariant.findAll({ where: { imageId: job.imageId } });
    rows.sort((a, b) => VARIANT_KINDS.indexOf(a.kind) - VARIANT_KINDS.indexOf(b.kind));
    return { ...toPipelineSummary(job), variants: await Promise.all(rows.map(toVariantDto)) };
  },

  /**
   * Runs the pipeline again from the original. Allowed only once the current run has finished, and
   * decided by a conditional update, so two requests at the same moment start one run, not two.
   */
  async reprocess(userId: string, imageId: string): Promise<PipelineDto> {
    const image = await findOwnedImage(userId, imageId);
    if (image.status !== 'accepted') {
      throw Errors.conflict('NOT_ACCEPTED', 'Only accepted photos are processed.');
    }

    // Photos accepted before the pipeline existed have no job yet: this starts their first run.
    const [existing, created] = await PipelineJob.findOrCreate({
      where: { imageId: image.id },
      defaults: { imageId: image.id, queuedAt: new Date() },
    });

    let job = existing;
    if (!created) {
      const [, rows] = await PipelineJob.update(
        { ...FRESH_RUN, run: sequelize.literal('run + 1'), queuedAt: new Date() },
        { where: { imageId: image.id, status: ['completed', 'failed'] }, returning: true },
      );
      if (!rows[0]) throw Errors.conflict('PIPELINE_BUSY', 'This photo is already being processed.');
      job = rows[0];
    }

    await enqueuePipelineStage('conversion', { imageId: image.id, run: job.run }).catch((error: unknown) =>
      logger.error({ err: error, imageId }, 'failed to queue reprocess; maintenance will retry'),
    );
    logger.info({ imageId, run: job.run }, 'pipeline reprocess requested');
    await publishImageEvent(userId, { type: 'image.updated', image: await toImageDto(image, job) });
    return toPipelineDto(job);
  },
};
