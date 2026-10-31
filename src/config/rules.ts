/**
 * Business rules for uploads and photo validation, kept in one place so thresholds can be tuned
 * without touching the pipeline code.
 */

export const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif'] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export const uploadRules = {
  maxFileBytes: 25 * 1024 * 1024,
  maxImagesPerUser: 100,
  maxPendingUploadsPerUser: 20,
  uploadUrlTtlSeconds: 5 * 60,
  /** Uploads that never complete are removed after this long. */
  pendingUploadExpiryMinutes: 60,
  /** Queued images older than this are re-enqueued in case the job never reached Redis. */
  staleQueuedMinutes: 10,
  minAcceptedPhotos: 6,
  targetAcceptedPhotos: 10,
} as const;

export const validationRules = {
  minFileBytes: 20 * 1024,
  minShortSidePx: 512,
  /** Decoding limit; guards against decompression bombs. 60 MP covers 48 MP phone cameras. */
  maxInputPixels: 60_000_000,
  /** Variance of the Laplacian on the face crop; below this the face is considered blurry. */
  minSharpness: 60,
  faceMinConfidence: 0.75,
  /** Longest side of the main face divided by the image's shortest side. */
  minFaceSizeRatio: 0.15,
  /** Other faces count towards "multiple faces" only when at least this big relative to the main face. */
  secondaryFaceMinRelativeSize: 0.35,
  /** Max Hamming distance between 64-bit difference hashes for two photos to count as near-duplicates. */
  maxSimilarityDistance: 10,
} as const;

/** Same keys as validationRules, with plain numbers so other thresholds can be passed in. */
export type ValidationRules = { readonly [K in keyof typeof validationRules]: number };
