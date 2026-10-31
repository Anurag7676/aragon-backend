import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import type { OtpPurpose } from '../db/models/index.js';
import { logger } from '../lib/logger.js';

const transporter =
  env.SMTP_USER && env.SMTP_PASS
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      })
    : null;

const COPY: Record<OtpPurpose, { subject: string; intro: string }> = {
  verify_email: {
    subject: 'Your verification code',
    intro: 'Use this code to verify your email address.',
  },
  reset_password: {
    subject: 'Your password reset code',
    intro: 'Use this code to reset your password. If you did not ask for this, you can ignore this email.',
  },
};

export async function sendOtpEmail(to: string, code: string, purpose: OtpPurpose, ttlMinutes: number): Promise<void> {
  const { subject, intro } = COPY[purpose];

  if (!transporter) {
    // Only reachable outside production (env validation requires SMTP there).
    logger.warn({ to, purpose, otp: code }, 'SMTP not configured; OTP logged for local development');
    return;
  }

  await transporter.sendMail({
    from: env.MAIL_FROM ?? env.SMTP_USER,
    to,
    subject,
    text: `${intro}\n\n${code}\n\nThe code expires in ${ttlMinutes} minutes.`,
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:420px;color:#111">
        <p style="font-size:15px;line-height:1.5">${intro}</p>
        <p style="font-size:30px;font-weight:600;letter-spacing:8px;margin:24px 0">${code}</p>
        <p style="font-size:13px;color:#666">The code expires in ${ttlMinutes} minutes.</p>
      </div>`,
  });
}
