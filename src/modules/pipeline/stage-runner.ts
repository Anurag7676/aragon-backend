import { UnrecoverableError, type Job } from 'bullmq';
import { Op, type InferAttributes, type Transaction } from 'sequelize';
import { env } from '../../config/env.js';
import { PIPELINE_STAGES, pipelineRules, type PipelineStage } from '../../config/pipeline.js';
import { Image, ImageVariant, PipelineJob, type PipelineStatus } from '../../db/models/index.js';
import { sequelize } from '../../db/sequelize.js';
import { enqueuePipelineStage, type PipelineJobData } from '../../integrations/queue.js';
import { imageKeys, objectUrl, pipelineKeys, storage } from '../../integrations/s3.js';
import { logger } from '../../lib/logger.js';
import { compressImage } from '../../processing/compress.js';
import { convertImage } from '../../processing/convert.js';
import { generateVariants } from '../../processing/variants.js';
import { publishImageEvent } from '../images/image-events.js';
import { toImageDto } from '../images/images.dto.js';
import { describeFailure, PipelineError, type Failure } from './pipeline-errors.js';

type JobFields = Partial<InferAttributes<PipelineJob>>;

/** The status a job has while a stage is running (and, after the first stage, while it waits for it). */
const RUNNING_STATUS: Record<PipelineStage, PipelineStatus> = {
  conversion: 'converting',
  compression: 'compressing',
  variants: 'generating_variants',
};

const STARTED_AT: Record<PipelineStage, 'conversionStartedAt' | 'compressionStartedAt' | 'variantsStartedAt'> = {
  conversion: 'conversionStartedAt',
  compression: 'compressionStartedAt',
  variants: 'variantsStartedAt',
};

/** The stage a job is waiting for or running, or null once it has finished. */
export function dueStage(status: PipelineStatus): PipelineStage | null {
  switch (status) {
    case 'queued':
    case 'converting':
      return 'conversion';
    case 'compressing':
      return 'compression';
    case 'generating_variants':
      return 'variants';
    default:
      return null;
  }
}

const faultStage = () => (env.ALLOW_FAULT_INJECTION ? env.PIPELINE_FAULT_STAGE : undefined);

/**
 * Runs one stage for one image. Safe to call any number of times with the same job: every database
 * write is conditional on the run and the expected status, and every file has a fixed key.
 */
export async function runStage(stage: PipelineStage, data: PipelineJobData): Promise<void> {
  const job = await PipelineJob.findOne({ where: { imageId: data.imageId } });
  // The image was deleted, or a reprocess started a newer run that now owns the files.
  if (!job || job.run !== data.run) return;

  const due = dueStage(job.status);
  if (due === null) return; // Already completed or failed.
  if (due !== stage) {
    // A repeat delivery of a stage that already finished. The earlier delivery may have crashed
    // between saving and queueing the next stage, so make sure that one is queued, then stop.
    if (PIPELINE_STAGES.indexOf(due) > PIPELINE_STAGES.indexOf(stage)) await enqueuePipelineStage(due, data);
    return;
  }

  const image = await Image.findByPk(data.imageId);
  if (!image) return;

  const started = await transition(job, { status: RUNNING_STATUS[stage], [STARTED_AT[stage]]: new Date() });
  if (!started) return;
  await publish(image, started);

  if (faultStage() === stage) {
    throw new PipelineError('INJECTED_FAILURE', `The ${stage} service is set to fail on purpose (fault injection).`, true);
  }

  await withTimeout(STAGES[stage](image, started), pipelineRules.stageTimeoutMs, stage);
}

const STAGES: Record<PipelineStage, (image: Image, job: PipelineJob) => Promise<void>> = {
  async conversion(image, job) {
    const original = await storage.getBuffer(image.originalKey);
    if (!original) throw new PipelineError('SOURCE_MISSING', 'The original upload is missing from storage.', true);

    const converted = await convertImage(original);
    await storage.put(imageKeys(image.userId, image.id).converted, converted.data, 'image/jpeg');

    const next = await transition(job, {
      status: 'compressing',
      convertedAt: new Date(),
      sourceFormat: converted.sourceFormat,
      width: converted.width,
      height: converted.height,
      originalBytes: original.length,
      convertedBytes: converted.data.length,
    });
    await handOff(image, next, 'compression');
  },

  async compression(image, job) {
    const keys = imageKeys(image.userId, image.id);
    const converted = await storage.getBuffer(keys.converted);
    if (!converted) throw missingIntermediate('converted');

    const result = await compressImage(converted);
    await storage.put(keys.compressed, result.data, 'image/jpeg');

    const next = await transition(job, {
      status: 'generating_variants',
      compressedAt: new Date(),
      compressedBytes: result.outputBytes,
      compressionRatio: result.ratio,
      jpegQuality: result.quality,
    });
    await handOff(image, next, 'variants');
  },

  async variants(image, job) {
    const keys = imageKeys(image.userId, image.id);
    const master = await storage.getBuffer(keys.compressed);
    if (!master) throw missingIntermediate('compressed');

    const variants = await generateVariants(master, job.jpegQuality ?? pipelineRules.compressionQuality);
    await Promise.all(variants.map((variant) => storage.put(keys.variants[variant.kind], variant.data, variant.contentType)));

    const completed = await sequelize.transaction(async (transaction) => {
      const done = await transition(job, { status: 'completed', completedAt: new Date() }, transaction);
      if (!done) return null;
      // One row per image and size: a repeat run updates the rows instead of adding more.
      await ImageVariant.bulkCreate(
        variants.map((variant) => ({
          imageId: image.id,
          kind: variant.kind,
          run: job.run,
          s3Key: keys.variants[variant.kind],
          url: objectUrl(keys.variants[variant.kind]),
          width: variant.width,
          height: variant.height,
          bytes: variant.data.length,
          format: variant.format,
          contentType: variant.contentType,
        })),
        {
          transaction,
          conflictAttributes: ['imageId', 'kind'],
          updateOnDuplicate: ['run', 's3Key', 'url', 'width', 'height', 'bytes', 'format', 'contentType', 'updatedAt'],
        },
      );
      return done;
    });

    if (!completed) return cleanUpIfDeleted(image);
    await storage
      .deleteMany([keys.converted, keys.compressed])
      .catch((error: unknown) => logger.warn({ err: error, imageId: image.id }, 'failed to delete pipeline intermediates'));
    logger.info({ imageId: image.id, run: job.run, ratio: completed.compressionRatio }, 'pipeline completed');
    await publish(image, completed);
  },
};

const missingIntermediate = (name: string) =>
  new PipelineError('SOURCE_MISSING', `The ${name} file from the previous step is missing. Reprocess to start again.`, true);

/**
 * Moves the job on, but only if it is still in the run and status this worker read. Returns the
 * updated row, or null if something else changed it first (a repeat delivery, a delete).
 */
async function transition(job: PipelineJob, fields: JobFields, transaction?: Transaction): Promise<PipelineJob | null> {
  const [, rows] = await PipelineJob.update(fields, {
    where: { id: job.id, run: job.run, status: job.status },
    returning: true,
    ...(transaction ? { transaction } : {}),
  });
  return rows[0] ?? null;
}

async function handOff(image: Image, next: PipelineJob | null, stage: PipelineStage): Promise<void> {
  if (!next) return cleanUpIfDeleted(image);
  await enqueuePipelineStage(stage, { imageId: image.id, run: next.run });
  await publish(image, next);
}

/** If the photo was deleted while this stage ran, remove the files the stage just wrote. */
async function cleanUpIfDeleted(image: Image): Promise<void> {
  if ((await PipelineJob.count({ where: { imageId: image.id } })) > 0) return;
  await storage.deleteMany(pipelineKeys(image.userId, image.id));
}

async function publish(image: Image, job: PipelineJob): Promise<void> {
  await publishImageEvent(image.userId, { type: 'image.updated', image: await toImageDto(image, job) });
}

async function withTimeout<T>(work: Promise<T>, ms: number, stage: PipelineStage): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // If the timeout wins, the work keeps going in the background; its result is ignored and its
  // database writes are conditional, so a retry can't be overwritten by it.
  work.catch(() => {});
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PipelineError('TIMEOUT', `The ${stage} step took longer than ${ms / 1000} s.`, false)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Records a failure on the job, unless it already finished or a newer run replaced it. */
export async function markPipelineFailed(data: PipelineJobData, stage: PipelineStage, failure: Failure): Promise<void> {
  const [, rows] = await PipelineJob.update(
    {
      status: 'failed',
      failedStage: stage,
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 500),
      failedAt: new Date(),
    },
    {
      where: { imageId: data.imageId, run: data.run, status: { [Op.notIn]: ['completed', 'failed'] } },
      returning: true,
    },
  );
  const job = rows[0];
  if (!job) return;

  logger.warn({ ...data, stage, code: failure.code }, 'pipeline job failed');
  const image = await Image.findByPk(data.imageId);
  if (image) await publish(image, job);
}

/**
 * BullMQ processor for a stage. Permanent errors, and the last retry of temporary ones, are saved on
 * the job before BullMQ is told to stop, so a failure is never silent.
 */
export async function processStageJob(stage: PipelineStage, job: Job<PipelineJobData>): Promise<void> {
  try {
    await runStage(stage, job.data);
  } catch (error) {
    const failure = describeFailure(error);
    const attempt = job.attemptsMade + 1;
    const lastAttempt = failure.permanent || attempt >= (job.opts.attempts ?? 1);
    logger[lastAttempt ? 'error' : 'warn'](
      { err: error, stage, ...job.data, attempt, code: failure.code },
      lastAttempt ? 'pipeline stage failed' : 'pipeline stage failed, will retry',
    );
    if (!lastAttempt) throw error;
    await markPipelineFailed(job.data, stage, failure);
    throw new UnrecoverableError(failure.message);
  }
}
