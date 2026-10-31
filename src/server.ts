import { createApp } from './app.js';
import { env } from './config/env.js';
import './db/models/index.js';
import { sequelize } from './db/sequelize.js';
import { imageQueue, maintenanceQueue } from './integrations/queue.js';
import { redis } from './integrations/redis.js';
import { logger } from './lib/logger.js';
import { imageEventHub } from './modules/images/image-events.js';

await sequelize.authenticate();
imageEventHub.start();

const server = createApp().listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down api');

  // Stop accepting connections, then end open event streams so close() can finish.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  await imageEventHub.stop();
  await closed;
  await Promise.allSettled([imageQueue.close(), maintenanceQueue.close(), sequelize.close()]);
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
