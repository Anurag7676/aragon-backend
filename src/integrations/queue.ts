import { Queue } from 'bullmq';
import { redis } from './redis.js';

export const IMAGE_QUEUE = 'image-processing';
export const MAINTENANCE_QUEUE = 'maintenance';

export interface ImageJobData {
  imageId: string;
}

export const imageQueue = new Queue<ImageJobData>(IMAGE_QUEUE, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  },
});

export const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: redis });

/** The job id is the image id, so enqueueing the same image twice is a no-op. */
export const enqueueImageProcessing = (imageId: string) =>
  imageQueue.add('process-image', { imageId }, { jobId: imageId });
