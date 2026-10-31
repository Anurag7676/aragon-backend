import { z } from 'zod';
import { OTP_PURPOSES } from '../../db/models/index.js';

const email = z
  .string({ error: 'Enter your email address.' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address.' }).max(320));

// NIST 800-63B: length over composition rules.
const newPassword = z
  .string({ error: 'Enter a password.' })
  .min(8, 'Use at least 8 characters.')
  .max(128, 'Use at most 128 characters.');

const code = z
  .string({ error: 'Enter the 6-digit code.' })
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code.');

export const signupSchema = z.object({ email, password: newPassword });
export const verifyEmailSchema = z.object({ email, code });
export const resendOtpSchema = z.object({ email, purpose: z.enum(OTP_PURPOSES) });
export const loginSchema = z.object({ email, password: z.string().min(1, 'Enter your password.').max(128) });
export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ email, code, password: newPassword });

export type SignupInput = z.infer<typeof signupSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type ResendOtpInput = z.infer<typeof resendOtpSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
