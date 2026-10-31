import type { Request, Response } from 'express';
import { currentUserId } from '../../middleware/authenticate.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './auth.cookies.js';
import {
  forgotPasswordSchema,
  loginSchema,
  resendOtpSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
} from './auth.schemas.js';
import { authService, type AuthSession } from './auth.service.js';
import type { ClientMeta } from './token.service.js';

const clientMeta = (req: Request): ClientMeta => ({ userAgent: req.get('user-agent'), ipAddress: req.ip });

/** The refresh token goes into the httpOnly cookie only; the body carries the short-lived access token. */
function sendSession(res: Response, session: AuthSession, status = 200): void {
  setRefreshCookie(res, session.refreshToken.token, session.refreshToken.expiresAt);
  res.status(status).json({ user: session.user, accessToken: session.accessToken, expiresIn: session.expiresIn });
}

export const authController = {
  async signup(req: Request, res: Response) {
    const result = await authService.signup(signupSchema.parse(req.body));
    res.status(201).json(result);
  },

  async verifyEmail(req: Request, res: Response) {
    const session = await authService.verifyEmail(verifyEmailSchema.parse(req.body), clientMeta(req));
    sendSession(res, session);
  },

  async resendOtp(req: Request, res: Response) {
    res.status(202).json(await authService.resendOtp(resendOtpSchema.parse(req.body)));
  },

  async login(req: Request, res: Response) {
    const session = await authService.login(loginSchema.parse(req.body), clientMeta(req));
    sendSession(res, session);
  },

  async refresh(req: Request, res: Response) {
    try {
      const session = await authService.refresh(readRefreshCookie(req), clientMeta(req));
      sendSession(res, session);
    } catch (error) {
      clearRefreshCookie(res);
      throw error;
    }
  },

  async logout(req: Request, res: Response) {
    await authService.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
    res.status(204).end();
  },

  async forgotPassword(req: Request, res: Response) {
    res.status(202).json(await authService.forgotPassword(forgotPasswordSchema.parse(req.body)));
  },

  async resetPassword(req: Request, res: Response) {
    await authService.resetPassword(resetPasswordSchema.parse(req.body));
    clearRefreshCookie(res);
    res.status(204).end();
  },

  async me(req: Request, res: Response) {
    res.json({ user: await authService.me(currentUserId(req)) });
  },
};
