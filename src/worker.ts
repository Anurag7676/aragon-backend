import { Worker } from 'bullmq';
import { env } from './config/env.js';
import './db/models/index.js';
import { sequelize } from './db/sequelize.js';
import {
  IMAGE_QUEUE,
  imageQueue,
  MAINTENANCE_QUEUE,
  maintenanceQueue,
  type ImageJobData,
} from './integrations/queue.js';
import { createRedisConnection, redis } from './integrations/redis.js';
import { logger } from './lib/logger.js';
import { markImageFailed, processImageJob } from './modules/images/process-image.job.js';
import { runUploadMaintenance } from './modules/images/upload-maintenance.job.js';
import { warmUpFaceDetector } from './processing/face-detector.js';

await sequelize.authenticate();
await warmUpFaceDetector();

const imageWorker = new Worker<ImageJobData>(IMAGE_QUEUE, (job) => processImageJob(job.data.imageId), {
  connection: createRedisConnection(),
  concurrency: env.WORKER_CONCURRENCY,
});

imageWorker.on('failed', (job, error) => {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1) || error.name === 'UnrecoverableError';
  logger.error({ err: error, imageId: job.data.imageId, attempt: job.attemptsMade, exhausted }, 'image job failed');
  if (exhausted) {
    markImageFailed(job.data.imageId, error.message).catch((markError: unknown) =>
      logger.error({ err: markError, imageId: job.data.imageId }, 'failed to mark image as failed'),
    );
  }
});

const maintenanceWorker = new Worker(MAINTENANCE_QUEUE, () => runUploadMaintenance(), {
  connection: createRedisConnection(),
  concurrency: 1,
});
await maintenanceQueue.upsertJobScheduler('upload-maintenance', { every: 15 * 60_000 }, { name: 'upload-maintenance' });

logger.info({ concurrency: env.WORKER_CONCURRENCY }, 'worker started');

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down worker');
  // close() waits for jobs in progress to finish.
  await Promise.allSettled([imageWorker.close(), maintenanceWorker.close()]);
  await Promise.allSettled([imageQueue.close(), maintenanceQueue.close(), sequelize.close()]);
  await redis.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
