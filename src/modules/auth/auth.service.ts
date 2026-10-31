import { UniqueConstraintError } from 'sequelize';
import { User } from '../../db/models/index.js';
import { sequelize } from '../../db/sequelize.js';
import { Errors } from '../../lib/errors.js';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from '../../lib/password.js';
import type {
  ForgotPasswordInput,
  LoginInput,
  ResendOtpInput,
  ResetPasswordInput,
  SignupInput,
  VerifyEmailInput,
} from './auth.schemas.js';
import { checkOtp, issueOtp, OTP_RESEND_COOLDOWN_SECONDS, otpError } from './otp.service.js';
import {
  createRefreshToken,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  type ClientMeta,
  type IssuedRefreshToken,
} from './token.service.js';

export interface UserDto {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface AuthSession {
  user: UserDto;
  accessToken: string;
  expiresIn: number;
  refreshToken: IssuedRefreshToken;
}

/** Returned by endpoints that send a code; the client shows a resend countdown from it. */
export interface CodeSentResponse {
  email: string;
  resendAfterSeconds: number;
}

const toUserDto = (user: User): UserDto => ({
  id: user.id,
  email: user.email,
  emailVerified: user.emailVerifiedAt !== null,
  createdAt: user.createdAt.toISOString(),
});

async function startSession(user: User, meta: ClientMeta): Promise<AuthSession> {
  const [access, refreshToken] = await Promise.all([signAccessToken(user.id), createRefreshToken(user.id, meta)]);
  return { user: toUserDto(user), accessToken: access.token, expiresIn: access.expiresIn, refreshToken };
}

export const authService = {
  /**
   * Creates an unverified account and emails a verification code. Signing up again with an email that
   * was never verified replaces that account's password, so nobody can squat an address they don't own.
   */
  async signup({ email, password }: SignupInput): Promise<CodeSentResponse> {
    const existing = await User.findOne({ where: { email } });
    if (existing?.emailVerifiedAt) {
      throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists. Log in instead.');
    }

    const passwordHash = await hashPassword(password);
    let user: User;
    try {
      user = existing ? await existing.update({ passwordHash }) : await User.create({ email, passwordHash, emailVerifiedAt: null, passwordChangedAt: null });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists. Log in instead.');
      }
      throw error;
    }

    await issueOtp(user, 'verify_email');
    return { email: user.email, resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS };
  },

  async verifyEmail({ email, code }: VerifyEmailInput, meta: ClientMeta): Promise<AuthSession> {
    const user = await User.findOne({ where: { email } });
    if (!user) throw otpError({ ok: false, reason: 'missing' });
    if (user.emailVerifiedAt) {
      throw Errors.conflict('ALREADY_VERIFIED', 'This email is already verified. Log in instead.');
    }

    const check = await sequelize.transaction(async (transaction) => {
      const result = await checkOtp(user.id, 'verify_email', code, transaction);
      if (result.ok) await user.update({ emailVerifiedAt: new Date() }, { transaction });
      return result;
    });
    if (!check.ok) throw otpError(check);

    return startSession(user, meta);
  },

  /** Always answers the same way so it can't be used to find out which emails have accounts. */
  async resendOtp({ email, purpose }: ResendOtpInput): Promise<CodeSentResponse> {
    const user = await User.findOne({ where: { email } });
    const eligible = user && (purpose === 'reset_password' || !user.emailVerifiedAt);
    if (eligible) await issueOtp(user, purpose);
    return { email, resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS };
  },

  async login({ email, password }: LoginInput, meta: ClientMeta): Promise<AuthSession> {
    const user = await User.scope('withPassword').findOne({ where: { email } });
    const passwordOk = user ? await verifyPassword(password, user.passwordHash) : await verifyAgainstDummyHash(password);
    if (!user || !passwordOk) {
      throw Errors.unauthorized('Incorrect email or password.', 'INVALID_CREDENTIALS');
    }

    if (!user.emailVerifiedAt) {
      await issueOtp(user, 'verify_email');
      throw Errors.forbidden('EMAIL_NOT_VERIFIED', 'Verify your email to continue. We sent you a code.', {
        email: user.email,
        resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
      });
    }

    return startSession(user, meta);
  },

  async refresh(rawToken: string | undefined, meta: ClientMeta): Promise<AuthSession> {
    if (!rawToken) throw Errors.unauthorized('Please log in to continue.', 'NO_SESSION');

    const rotation = await rotateRefreshToken(rawToken, meta);
    if (!rotation.ok) {
      throw Errors.unauthorized('Your session has ended. Please log in again.', 'SESSION_ENDED');
    }

    const user = await User.findByPk(rotation.userId);
    if (!user) throw Errors.unauthorized('Your session has ended. Please log in again.', 'SESSION_ENDED');

    const access = await signAccessToken(user.id);
    return { user: toUserDto(user), accessToken: access.token, expiresIn: access.expiresIn, refreshToken: rotation.refreshToken };
  },

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken) await revokeRefreshToken(rawToken);
  },

  /** Same response whether or not the account exists. */
  async forgotPassword({ email }: ForgotPasswordInput): Promise<CodeSentResponse> {
    const user = await User.findOne({ where: { email } });
    if (user) await issueOtp(user, 'reset_password');
    return { email, resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS };
  },

  /** Sets a new password and signs the user out of every device. */
  async resetPassword({ email, code, password }: ResetPasswordInput): Promise<void> {
    const user = await User.findOne({ where: { email } });
    if (!user) throw otpError({ ok: false, reason: 'missing' });

    const passwordHash = await hashPassword(password);
    const check = await sequelize.transaction(async (transaction) => {
      const result = await checkOtp(user.id, 'reset_password', code, transaction);
      if (result.ok) {
        const now = new Date();
        // Receiving the code proves the inbox is theirs, so this also verifies the email.
        await user.update(
          { passwordHash, passwordChangedAt: now, emailVerifiedAt: user.emailVerifiedAt ?? now },
          { transaction },
        );
        await revokeAllRefreshTokens(user.id, transaction);
      }
      return result;
    });
    if (!check.ok) throw otpError(check);
  },

  async me(userId: string): Promise<UserDto> {
    const user = await User.findByPk(userId);
    if (!user) throw Errors.unauthorized('Your session has ended. Please log in again.', 'SESSION_ENDED');
    return toUserDto(user);
  },
};
