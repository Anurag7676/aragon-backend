import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z, ZodError } from 'zod';
import { AppError, Errors } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export const notFoundHandler: RequestHandler = () => {
  throw Errors.notFound('Route');
};

interface BodyParserError {
  type?: string;
  status?: number;
}

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const requestId = req.id;

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: error.issues[0]?.message ?? 'Some fields are invalid.',
        details: { fields: z.flattenError(error).fieldErrors },
        requestId,
      },
    });
    return;
  }

  if (error instanceof AppError) {
    const retryAfter = error.details?.retryAfterSeconds;
    if (typeof retryAfter === 'number') res.setHeader('Retry-After', String(retryAfter));
    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details, requestId },
    });
    return;
  }

  const bodyError = error as BodyParserError;
  if (bodyError.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.', requestId } });
    return;
  }
  if (bodyError.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.', requestId } });
    return;
  }

  logger.error({ err: error, requestId, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.', requestId } });
};
