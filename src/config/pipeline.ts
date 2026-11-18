/**
 * Settings for the media pipeline that runs after a photo is accepted. Kept apart from the
 * validation rules so sizes and quality can be tuned without touching the services.
 */

/** The three services, in the order a photo goes through them. */
export const PIPELINE_STAGES = ['conversion', 'compression', 'variants'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const VARIANT_KINDS = ['thumbnail', 'web', 'full'] as const;
export type VariantKind = (typeof VARIANT_KINDS)[number];

export const pipelineRules = {
  /** Conversion writes a near-lossless master; compression decides the final quality. */
  conversionQuality: 95,
  compressionQuality: 80,
  /** Square crop centred on the most interesting region (usually the face). */
  thumbnailSize: 256,
  /** Longest side of the web variant. Smaller photos are never enlarged. */
  webMaxSide: 1280,
  /** A stage that runs longer than this is treated as failed (and retried). */
  stageTimeoutMs: 60_000,
  stageAttempts: 3,
  /** Unfinished jobs untouched for this long are checked by the maintenance sweep. */
  staleMinutes: 10,
} as const;
