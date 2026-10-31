import type { NextFunction, Request, Response } from 'express';
import { Errors } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';

/** Requires a valid `Authorization: Bearer <access token>` header and sets req.user. */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  if (!token) throw Errors.unauthorized();

  try {
    const { userId } = await verifyAccessToken(token);
    req.user = { id: userId };
  } catch {
    throw Errors.unauthorized('Your session has expired. Please log in again.', 'TOKEN_INVALID');
  }
  next();
}

/** The authenticated user's id; only valid on routes behind `authenticate`. */
export function currentUserId(req: Request): string {
  if (!req.user) throw Errors.unauthorized();
  return req.user.id;
}
