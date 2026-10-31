import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { Errors } from '../lib/errors.js';

/**
 * CSRF guard for routes authenticated by cookie (refresh, logout). Browsers always send Origin on
 * POST, so a request from any page outside the allowlist is refused. Non-browser clients send no
 * Origin and are not a CSRF vector.
 */
export function requireTrustedOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  if (origin && !env.APP_ORIGINS.includes(origin)) {
    throw Errors.forbidden('UNTRUSTED_ORIGIN', 'This request is not allowed from this site.');
  }
  next();
}
