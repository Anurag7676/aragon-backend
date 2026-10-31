import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

// OWASP minimum recommendation for argon2id.
const DEFAULT_PARAMS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const;

const toB64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

/** Hashes a password with argon2id and returns a PHC string ($argon2id$v=19$m=...,t=...,p=...$salt$hash). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2Async('argon2id', { message: password, nonce: salt, ...DEFAULT_PARAMS });
  const { memory, passes, parallelism } = DEFAULT_PARAMS;
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${toB64(salt)}$${toB64(hash)}`;
}

const PHC_PATTERN = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const match = PHC_PATTERN.exec(phc);
  if (!match) return false;
  const [, memory, passes, parallelism, salt, expectedHash] = match;
  const expected = Buffer.from(expectedHash!, 'base64');
  const actual = await argon2Async('argon2id', {
    message: password,
    nonce: Buffer.from(salt!, 'base64'),
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real verification. Used when the email is unknown so response timing
 * doesn't reveal which accounts exist.
 */
export async function verifyAgainstDummyHash(password: string): Promise<false> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummyHash);
  return false;
}
