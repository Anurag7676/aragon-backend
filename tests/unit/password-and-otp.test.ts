import { describe, expect, it } from 'vitest';
import { randomNumericCode, safeEqualHex, sha256Hex } from '../../src/lib/crypto.js';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from '../../src/lib/password.js';
import { otpError } from '../../src/modules/auth/otp.service.js';

describe('password hashing', () => {
  it('produces an argon2id PHC string with the configured parameters', async () => {
    expect(await hashPassword('correct-horse')).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/,
    );
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'));
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct-horse');
    expect(await verifyPassword('correct-horse', hash)).toBe(true);
    expect(await verifyPassword('correct-horsE', hash)).toBe(false);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '$argon2i$v=19$m=1,t=1,p=1$c2FsdA$aGFzaA')).toBe(false);
  });

  it('always fails the dummy check used for unknown emails', async () => {
    expect(await verifyAgainstDummyHash('dummy-password-for-timing')).toBe(false);
  });
});

describe('codes and comparisons', () => {
  it('generates zero-padded six-digit codes', () => {
    for (let i = 0; i < 200; i++) expect(randomNumericCode(6)).toMatch(/^\d{6}$/);
  });

  it('compares hex digests in constant time and handles length mismatch', () => {
    const digest = sha256Hex('value');
    expect(safeEqualHex(digest, sha256Hex('value'))).toBe(true);
    expect(safeEqualHex(digest, sha256Hex('other'))).toBe(false);
    expect(safeEqualHex(digest, 'abcd')).toBe(false);
  });
});

describe('otpError', () => {
  it('maps each failure to a stable code and status', () => {
    expect(otpError({ ok: false, reason: 'invalid', attemptsRemaining: 3 })).toMatchObject({
      status: 400,
      code: 'INVALID_CODE',
      details: { attemptsRemaining: 3 },
    });
    expect(otpError({ ok: false, reason: 'expired' })).toMatchObject({ status: 400, code: 'CODE_EXPIRED' });
    expect(otpError({ ok: false, reason: 'too_many_attempts' })).toMatchObject({
      status: 429,
      code: 'TOO_MANY_ATTEMPTS',
    });
    expect(otpError({ ok: false, reason: 'missing' })).toMatchObject({ status: 400, code: 'INVALID_CODE' });
  });
});
