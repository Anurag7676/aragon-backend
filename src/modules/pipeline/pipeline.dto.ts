import type { PipelineStage, VariantKind } from '../../config/pipeline.js';
import type { ImageVariant, PipelineJob, PipelineStatus } from '../../db/models/index.js';
import { storage } from '../../integrations/s3.js';

export interface PipelineErrorDto {
  stage: PipelineStage | null;
  code: string;
  message: string;
}

/** The short form carried on every image response and live event. */
export interface PipelineSummaryDto {
  status: PipelineStatus;
  run: number;
  error: PipelineErrorDto | null;
}

interface StageDuration {
  /** Time spent waiting in the stage's queue. */
  waitMs: number | null;
  /** Time spent running (the last attempt, if it was retried). */
  runMs: number | null;
}

export interface PipelineDto extends PipelineSummaryDto {
  imageId: string;
  sourceFormat: string | null;
  width: number | null;
  height: number | null;
  sizes: { originalBytes: number | null; convertedBytes: number | null; compressedBytes: number | null };
  /** convertedBytes / compressedBytes. */
  compressionRatio: number | null;
  /** How much smaller the compressed file is than the converted one, in percent. */
  savedPercent: number | null;
  jpegQuality: number | null;
  timings: Record<
    | 'queuedAt'
    | 'conversionStartedAt'
    | 'convertedAt'
    | 'compressionStartedAt'
    | 'compressedAt'
    | 'variantsStartedAt'
    | 'completedAt'
    | 'failedAt',
    string | null
  >;
  durations: Record<PipelineStage, StageDuration> & { totalMs: number | null };
  updatedAt: string;
}

export interface VariantDto {
  kind: VariantKind;
  /** Short-lived signed URL; the bucket is private. */
  url: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  contentType: string;
  run: number;
}

const iso = (date: Date | null) => date?.toISOString() ?? null;
const between = (from: Date | null, to: Date | null) => (from && to ? to.getTime() - from.getTime() : null);

export function toPipelineSummary(job: PipelineJob): PipelineSummaryDto {
  return {
    status: job.status,
    run: job.run,
    error: job.errorCode ? { stage: job.failedStage, code: job.errorCode, message: job.errorMessage ?? '' } : null,
  };
}

export function toPipelineDto(job: PipelineJob): PipelineDto {
  const saved =
    job.convertedBytes && job.compressedBytes
      ? Math.round((1 - job.compressedBytes / job.convertedBytes) * 1000) / 10
      : null;
  return {
    ...toPipelineSummary(job),
    imageId: job.imageId,
    sourceFormat: job.sourceFormat,
    width: job.width,
    height: job.height,
    sizes: {
      originalBytes: job.originalBytes,
      convertedBytes: job.convertedBytes,
      compressedBytes: job.compressedBytes,
    },
    compressionRatio: job.compressionRatio,
    savedPercent: saved,
    jpegQuality: job.jpegQuality,
    timings: {
      queuedAt: iso(job.queuedAt),
      conversionStartedAt: iso(job.conversionStartedAt),
      convertedAt: iso(job.convertedAt),
      compressionStartedAt: iso(job.compressionStartedAt),
      compressedAt: iso(job.compressedAt),
      variantsStartedAt: iso(job.variantsStartedAt),
      completedAt: iso(job.completedAt),
      failedAt: iso(job.failedAt),
    },
    durations: {
      conversion: {
        waitMs: between(job.queuedAt, job.conversionStartedAt),
        runMs: between(job.conversionStartedAt, job.convertedAt),
      },
      compression: {
        waitMs: between(job.convertedAt, job.compressionStartedAt),
        runMs: between(job.compressionStartedAt, job.compressedAt),
      },
      variants: {
        waitMs: between(job.compressedAt, job.variantsStartedAt),
        runMs: between(job.variantsStartedAt, job.completedAt),
      },
      totalMs: between(job.queuedAt, job.completedAt ?? job.failedAt),
    },
    updatedAt: job.updatedAt.toISOString(),
  };
}

export async function toVariantDto(variant: ImageVariant): Promise<VariantDto> {
  return {
    kind: variant.kind,
    url: await storage.readUrl(variant.s3Key),
    width: variant.width,
    height: variant.height,
    bytes: variant.bytes,
    format: variant.format,
    contentType: variant.contentType,
    run: variant.run,
  };
}
