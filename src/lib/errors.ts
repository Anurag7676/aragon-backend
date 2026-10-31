/** An error that is safe to show to the client: it carries an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(400, code, message, details),
  unauthorized: (message = 'Please log in to continue.', code = 'UNAUTHORIZED') => new AppError(401, code, message),
  forbidden: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(403, code, message, details),
  notFound: (resource: string) => new AppError(404, 'NOT_FOUND', `${resource} not found.`),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(409, code, message, details),
  tooManyRequests: (code: string, message: string, retryAfterSeconds?: number) =>
    new AppError(429, code, message, retryAfterSeconds ? { retryAfterSeconds } : undefined),
  serviceUnavailable: (code: string, message: string) => new AppError(503, code, message),
};
