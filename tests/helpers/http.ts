import type { Response } from 'supertest';
import { vi } from 'vitest';
import type { OtpPurpose } from '../../src/db/models/index.js';
import { sendOtpEmail } from '../../src/integrations/mailer.js';
import { REFRESH_COOKIE } from '../../src/modules/auth/auth.cookies.js';

export const TRUSTED_ORIGIN = 'http://localhost:5173';

/** The code most recently "emailed" to this address for this purpose. */
export function lastOtp(email: string, purpose: OtpPurpose): string {
  const call = vi
    .mocked(sendOtpEmail)
    .mock.calls.filter(([to, , callPurpose]) => to === email && callPurpose === purpose)
    .at(-1);
  if (!call) throw new Error(`No ${purpose} code was sent to ${email}`);
  return call[1];
}

/** The raw Set-Cookie line for the refresh cookie, if the response set one. */
export function refreshCookieHeader(res: Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const lines = Array.isArray(header) ? header : header ? [header] : [];
  return lines.find((line) => line.startsWith(`${REFRESH_COOKIE}=`));
}

/** "aragon_rt=<token>", ready to send back in a Cookie header. */
export function refreshCookie(res: Response): string {
  const line = refreshCookieHeader(res);
  if (!line) throw new Error('Response did not set the refresh cookie');
  return line.split(';')[0]!;
}

export const tokenFromCookie = (cookie: string) => cookie.slice(`${REFRESH_COOKIE}=`.length);
