import type { Request, Response } from 'express';
import type { Redis } from 'ioredis';
import { createRedisConnection, redis } from '../../integrations/redis.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { ImageDto } from './images.dto.js';

export type ImageEvent = { type: 'image.updated'; image: ImageDto } | { type: 'image.deleted'; imageId: string };

const CHANNEL_PREFIX = 'image-events:';
const channelFor = (userId: string) => `${CHANNEL_PREFIX}${userId}`;
const HEARTBEAT_MS = 20_000;

/**
 * Publishes through Redis so the event reaches the user's browser no matter which process made the
 * change (API or worker) or which API instance holds the browser's connection. Best effort: the
 * client also refetches on reconnect, so a lost event only delays an update.
 */
export async function publishImageEvent(userId: string, event: ImageEvent): Promise<void> {
  try {
    await redis.publish(channelFor(userId), JSON.stringify(event));
  } catch (error) {
    logger.warn({ err: error, userId, type: event.type }, 'failed to publish image event');
  }
}

/** Fans Redis messages out to the Server-Sent Events connections held by this API process. */
class ImageEventHub {
  private subscriber: Redis | null = null;
  private readonly clients = new Map<string, Set<Response>>();

  start(): void {
    if (this.subscriber) return;
    this.subscriber = createRedisConnection();
    this.subscriber.on('message', (channel: string, message: string) => {
      const listeners = this.clients.get(channel.slice(CHANNEL_PREFIX.length));
      if (!listeners) return;
      for (const res of listeners) res.write(`data: ${message}\n\n`);
    });
  }

  /** Subscribes to a user's channel only while that user has an open connection on this process. */
  async attach(userId: string, req: Request, res: Response): Promise<void> {
    // Only during startup/shutdown; the client reconnects on its own.
    if (!this.subscriber) throw Errors.serviceUnavailable('EVENTS_UNAVAILABLE', 'Live updates are restarting.');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops nginx from buffering the stream.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    let listeners = this.clients.get(userId);
    if (!listeners) {
      listeners = new Set();
      this.clients.set(userId, listeners);
      await this.subscriber.subscribe(channelFor(userId));
    }
    listeners.add(res);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      listeners.delete(res);
      if (listeners.size === 0) {
        this.clients.delete(userId);
        this.subscriber?.unsubscribe(channelFor(userId)).catch((error: unknown) => {
          logger.warn({ err: error }, 'failed to unsubscribe from image events');
        });
      }
    });
  }

  async stop(): Promise<void> {
    for (const listeners of this.clients.values()) {
      for (const res of listeners) res.end();
    }
    this.clients.clear();
    await this.subscriber?.quit();
    this.subscriber = null;
  }
}

export const imageEventHub = new ImageEventHub();
