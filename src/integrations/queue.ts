import { Queue } from 'bullmq';
import { PIPELINE_STAGES, pipelineRules, type PipelineStage } from '../config/pipeline.js';
import { redis } from './redis.js';

export const IMAGE_QUEUE = 'image-processing';
export const MAINTENANCE_QUEUE = 'maintenance';

/** One queue per pipeline service, so each service can be scaled on its own. */
export const PIPELINE_QUEUES: Record<PipelineStage, string> = {
  conversion: 'pipeline-conversion',
  compression: 'pipeline-compression',
  variants: 'pipeline-variants',
};

export interface ImageJobData {
  imageId: string;
}

export interface PipelineJobData {
  imageId: string;
  /** The pipeline run this job belongs to; a reprocess starts a new run. */
  run: number;
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

const pipelineQueues = Object.fromEntries(
  PIPELINE_STAGES.map((stage) => [
    stage,
    new Queue<PipelineJobData>(PIPELINE_QUEUES[stage], {
      connection: redis,
      defaultJobOptions: {
        attempts: pipelineRules.stageAttempts,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 5_000 },
        removeOnFail: { count: 5_000 },
      },
    }),
  ]),
) as Record<PipelineStage, Queue<PipelineJobData>>;

/** The job id is the image id, so enqueueing the same image twice is a no-op. */
export const enqueueImageProcessing = (imageId: string) =>
  imageQueue.add('process-image', { imageId }, { jobId: imageId });

/** Deterministic id per image, run and stage: queueing the same step twice adds one job. */
export const pipelineJobId = (stage: PipelineStage, data: PipelineJobData) => `${data.imageId}-r${data.run}-${stage}`;

export const enqueuePipelineStage = (stage: PipelineStage, data: PipelineJobData) =>
  pipelineQueues[stage].add(stage, data, { jobId: pipelineJobId(stage, data) });

/** Adds a stage job again even if Redis still holds a finished job with the same id. */
export async function requeuePipelineStage(stage: PipelineStage, data: PipelineJobData) {
  const existing = await pipelineQueues[stage].getJob(pipelineJobId(stage, data));
  if (existing && (await existing.isCompleted())) await existing.remove();
  return enqueuePipelineStage(stage, data);
}

/** Where a stage's job is in BullMQ, or null if Redis no longer has it. */
export async function pipelineJobState(stage: PipelineStage, data: PipelineJobData) {
  const job = await pipelineQueues[stage].getJob(pipelineJobId(stage, data));
  if (!job) return null;
  return { state: await job.getState(), failedReason: job.failedReason as string | undefined };
}

export interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
  /** Processes currently consuming this queue. */
  workers: number;
}

async function statsFor(queue: Queue): Promise<QueueStats> {
  const [counts, workers] = await Promise.all([
    queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed', 'completed'),
    queue.getWorkersCount(),
  ]);
  return {
    waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
    workers,
  };
}

/** Queue depth and consumers for validation and each pipeline stage. */
export async function getQueueStats(): Promise<Record<'validation' | PipelineStage, QueueStats>> {
  const [validation, conversion, compression, variants] = await Promise.all([
    statsFor(imageQueue),
    ...PIPELINE_STAGES.map((stage) => statsFor(pipelineQueues[stage])),
  ]);
  return { validation: validation!, conversion: conversion!, compression: compression!, variants: variants! };
}

export const closeQueues = () =>
  Promise.allSettled([imageQueue.close(), maintenanceQueue.close(), ...Object.values(pipelineQueues).map((q) => q.close())]);
