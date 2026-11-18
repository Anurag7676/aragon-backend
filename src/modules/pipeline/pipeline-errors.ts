import { S3ServiceException } from '@aws-sdk/client-s3';
import { UnreadableImageError, UnsupportedFormatError } from '../../processing/decode.js';

export type PipelineErrorCode =
  | 'SOURCE_MISSING'
  | 'UNSUPPORTED_FORMAT'
  | 'DECODE_FAILED'
  | 'TIMEOUT'
  | 'STORAGE_ERROR'
  | 'INJECTED_FAILURE'
  | 'PROCESSING_ERROR';

/** A failure with a stable code. Permanent ones stop the job at once; the rest are retried first. */
export class PipelineError extends Error {
  readonly code: PipelineErrorCode;
  readonly permanent: boolean;

  constructor(code: PipelineErrorCode, message: string, permanent: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PipelineError';
    this.code = code;
    this.permanent = permanent;
  }
}

export interface Failure {
  code: PipelineErrorCode;
  /** Safe to show to the photo's owner: no stack traces, hosts or SQL. */
  message: string;
  permanent: boolean;
}

/** Maps anything a stage can throw to a code and a message the user can act on. */
export function describeFailure(error: unknown): Failure {
  if (error instanceof PipelineError) return { code: error.code, message: error.message, permanent: error.permanent };
  if (error instanceof UnsupportedFormatError) {
    return { code: 'UNSUPPORTED_FORMAT', message: 'The file is not a JPEG, PNG or HEIC image.', permanent: true };
  }
  if (error instanceof UnreadableImageError) {
    return { code: 'DECODE_FAILED', message: `The image could not be decoded: ${error.message}.`, permanent: true };
  }
  if (error instanceof S3ServiceException) {
    return { code: 'STORAGE_ERROR', message: 'File storage was unavailable. Reprocess to try again.', permanent: false };
  }
  return { code: 'PROCESSING_ERROR', message: 'An unexpected error stopped processing. Reprocess to try again.', permanent: false };
}
