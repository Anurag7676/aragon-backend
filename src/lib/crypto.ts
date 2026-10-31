import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export const hmacSha256Hex = (secret: string, value: string): string =>
  createHmac('sha256', secret).update(value).digest('hex');

/** URL-safe random token, used for refresh tokens. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Uniformly random numeric code, e.g. "042917". */
export const randomNumericCode = (digits = 6): string => randomInt(0, 10 ** digits).toString().padStart(digits, '0');

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}
