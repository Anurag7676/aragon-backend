import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Shared connection for commands (queue producers, rate limits, pub/sub publishing).
 * maxRetriesPerRequest: null is required by BullMQ for blocking connections and keeps commands
 * waiting through a short Redis restart instead of failing.
 */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });

redis.on('error', (error) => logger.error({ err: error }, 'redis connection error'));

/** A dedicated connection, e.g. for SUBSCRIBE or a BullMQ worker. */
export const createRedisConnection = (): Redis => redis.duplicate();
