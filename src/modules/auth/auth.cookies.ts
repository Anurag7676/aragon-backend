import type { CookieOptions, Request, Response } from 'express';
import { env, isProduction } from '../../config/env.js';

export const REFRESH_COOKIE = 'aragon_rt';

const baseOptions = (): CookieOptions => ({
  httpOnly: true,
  // SameSite=None is only accepted on Secure cookies.
  secure: isProduction || env.REFRESH_COOKIE_SAMESITE === 'none',
  sameSite: env.REFRESH_COOKIE_SAMESITE,
  // Sent only to the auth routes, never with image requests.
  path: '/api/v1/auth',
});

export function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, { ...baseOptions(), expires: expiresAt });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, baseOptions());
}

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
