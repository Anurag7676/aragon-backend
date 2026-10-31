import type { Transaction } from 'sequelize';
import { env } from '../../config/env.js';
import { EmailOtp, type OtpPurpose, type User } from '../../db/models/index.js';
import { sequelize } from '../../db/sequelize.js';
import { sendOtpEmail } from '../../integrations/mailer.js';
import { hmacSha256Hex, randomNumericCode, safeEqualHex } from '../../lib/crypto.js';
import { AppError, Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

// Bound to the user and purpose so a code for one flow can't be replayed in another.
const hashCode = (userId: string, purpose: OtpPurpose, code: string) =>
  hmacSha256Hex(env.OTP_SECRET, `${userId}:${purpose}:${code}`);

export type OtpCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid'; attemptsRemaining: number }
  | { ok: false; reason: 'expired' | 'too_many_attempts' | 'missing' };

/**
 * Creates a new code (replacing any unused one) and emails it. Returns false without sending when a
 * code was sent less than the cooldown ago, so callers can respond the same way either way.
 */
export async function issueOtp(user: Pick<User, 'id' | 'email'>, purpose: OtpPurpose): Promise<boolean> {
  const latest = await EmailOtp.findOne({ where: { userId: user.id, purpose }, order: [['createdAt', 'DESC']] });
  if (latest && Date.now() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_SECONDS * 1000) {
    return false;
  }

  const code = randomNumericCode(6);
  const otp = await sequelize.transaction(async (transaction) => {
    await EmailOtp.destroy({ where: { userId: user.id, purpose, consumedAt: null }, transaction });
    return EmailOtp.create(
      {
        userId: user.id,
        purpose,
        codeHash: hashCode(user.id, purpose, code),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000),
        consumedAt: null,
      },
      { transaction },
    );
  });

  try {
    await sendOtpEmail(user.email, code, purpose, OTP_TTL_MINUTES);
  } catch (error) {
    // Drop the undelivered code so the user can ask for a new one straight away.
    await otp.destroy();
    logger.error({ err: error, userId: user.id, purpose }, 'failed to send OTP email');
    throw Errors.serviceUnavailable('EMAIL_DELIVERY_FAILED', "We couldn't send the email. Please try again.");
  }
  return true;
}

/**
 * Checks a code inside the caller's transaction. Never throws for a wrong code: the caller must let the
 * transaction commit so the failed attempt is counted, then turn the result into an error.
 */
export async function checkOtp(
  userId: string,
  purpose: OtpPurpose,
  code: string,
  transaction: Transaction,
): Promise<OtpCheck> {
  const otp = await EmailOtp.findOne({
    where: { userId, purpose, consumedAt: null },
    order: [['createdAt', 'DESC']],
    lock: transaction.LOCK.UPDATE,
    transaction,
  });

  if (!otp) return { ok: false, reason: 'missing' };
  if (otp.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (otp.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  if (!safeEqualHex(hashCode(userId, purpose, code), otp.codeHash)) {
    const attemptsUsed = otp.attempts + 1;
    await otp.increment('attempts', { transaction });
    const attemptsRemaining = OTP_MAX_ATTEMPTS - attemptsUsed;
    return attemptsRemaining > 0
      ? { ok: false, reason: 'invalid', attemptsRemaining }
      : { ok: false, reason: 'too_many_attempts' };
  }

  await otp.update({ consumedAt: new Date() }, { transaction });
  return { ok: true };
}

export function otpError(check: Exclude<OtpCheck, { ok: true }>): AppError {
  switch (check.reason) {
    case 'invalid':
      return Errors.badRequest('INVALID_CODE', 'That code is incorrect.', {
        attemptsRemaining: check.attemptsRemaining,
      });
    case 'expired':
      return Errors.badRequest('CODE_EXPIRED', 'That code has expired. Request a new one.');
    case 'too_many_attempts':
      return Errors.tooManyRequests('TOO_MANY_ATTEMPTS', 'Too many incorrect attempts. Request a new code.');
    case 'missing':
      return Errors.badRequest('INVALID_CODE', 'That code is incorrect. Request a new one.');
  }
}
