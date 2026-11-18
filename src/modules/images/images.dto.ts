import type { Image, ImageStatus, PipelineJob } from '../../db/models/index.js';
import { storage } from '../../integrations/s3.js';
import { toPipelineSummary, type PipelineSummaryDto } from '../pipeline/pipeline.dto.js';
import { describeRejection, type RejectionReasonDto } from './rejection-reasons.js';

export interface ImageDto {
  id: string;
  originalName: string;
  status: ImageStatus;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  rejectionReasons: RejectionReasonDto[];
  thumbnailUrl: string | null;
  imageUrl: string | null;
  createdAt: string;
  processedAt: string | null;
  /** Processing after acceptance; null until the photo is accepted. */
  pipeline: PipelineSummaryDto | null;
}

/** `pipeline` overrides the included association, for callers that just changed the job. */
export async function toImageDto(image: Image, pipeline?: PipelineJob | null): Promise<ImageDto> {
  const job = pipeline !== undefined ? pipeline : (image.pipeline ?? null);
  const [thumbnailUrl, imageUrl] = await Promise.all([
    image.thumbnailKey ? storage.readUrl(image.thumbnailKey) : null,
    image.displayKey ? storage.readUrl(image.displayKey) : null,
  ]);

  return {
    id: image.id,
    originalName: image.originalName,
    status: image.status,
    sizeBytes: image.sizeBytes,
    width: image.width,
    height: image.height,
    rejectionReasons: image.rejectionReasons.map(describeRejection).filter((reason) => reason !== null),
    thumbnailUrl,
    imageUrl,
    createdAt: image.createdAt.toISOString(),
    processedAt: image.processedAt?.toISOString() ?? null,
    pipeline: job ? toPipelineSummary(job) : null,
  };
}
