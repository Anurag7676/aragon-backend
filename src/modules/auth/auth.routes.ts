import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authIpLimiter, otpEmailLimiter } from '../../middleware/rate-limit.js';
import { requireTrustedOrigin } from '../../middleware/trusted-origin.js';
import { authController } from './auth.controller.js';

export const authRouter = Router();

authRouter.use(authIpLimiter);

authRouter.post('/signup', otpEmailLimiter, authController.signup);
authRouter.post('/verify-email', otpEmailLimiter, authController.verifyEmail);
authRouter.post('/resend-otp', otpEmailLimiter, authController.resendOtp);
authRouter.post('/login', authController.login);
authRouter.post('/forgot-password', otpEmailLimiter, authController.forgotPassword);
authRouter.post('/reset-password', otpEmailLimiter, authController.resetPassword);

// Cookie-authenticated, so guarded against cross-site requests.
authRouter.post('/refresh', requireTrustedOrigin, authController.refresh);
authRouter.post('/logout', requireTrustedOrigin, authController.logout);

authRouter.get('/me', authenticate, authController.me);
