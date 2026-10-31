import type { Request } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { Errors } from '../lib/errors.js';
import { redis } from '../integrations/redis.js';

const store = (prefix: string) =>
  new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
  });

const limiter = (prefix: string, options: Partial<Options>) =>
  rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: store(prefix),
    skip: () => env.NODE_ENV === 'test',
    handler: (_req, _res, next, opts) =>
      next(
        Errors.tooManyRequests(
          'RATE_LIMITED',
          'Too many requests. Please wait a moment and try again.',
          Math.ceil(opts.windowMs / 1000),
        ),
      ),
    ...options,
  });

const clientIp = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');

/** Per IP across all auth routes: slows password guessing and signup spam. */
export const authIpLimiter = limiter('auth-ip', { windowMs: 15 * 60_000, limit: 50, keyGenerator: clientIp });

/**
 * Per email on routes that send or check codes, so one inbox can't be flooded and one account's code
 * can't be brute-forced from many IPs. Falls back to the IP when the body has no email.
 */
export const otpEmailLimiter = limiter('otp-email', {
  windowMs: 15 * 60_000,
  limit: 10,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email ? `email:${email}` : `ip:${clientIp(req)}`;
  },
});

/** Per user on upload creation. */
export const uploadLimiter = limiter('upload', {
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (req) => req.user?.id ?? clientIp(req),
});
