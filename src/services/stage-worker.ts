import { Worker } from 'bullmq';
import sharp from 'sharp';
import { env } from '../config/env.js';
import type { PipelineStage } from '../config/pipeline.js';
import '../db/models/index.js';
import { sequelize } from '../db/sequelize.js';
import { closeQueues, PIPELINE_QUEUES, type PipelineJobData } from '../integrations/queue.js';
import { createRedisConnection, redis } from '../integrations/redis.js';
import { logger } from '../lib/logger.js';
import { describeFailure } from '../modules/pipeline/pipeline-errors.js';
import { markPipelineFailed, processStageJob } from '../modules/pipeline/stage-runner.js';

/**
 * Starts one pipeline service: a process that consumes a single stage's queue. It keeps no state of
 * its own (files are in S3, progress in Postgres, jobs in Redis), so any number of copies can run.
 */
export async function startStageWorker(stage: PipelineStage, concurrency: number): Promise<void> {
  // One libvips thread per image and no decoded-image cache: each job uses at most one core and its
  // memory is freed when it finishes, so adding copies of the service adds capacity predictably.
  sharp.concurrency(1);
  sharp.cache(false);

  await sequelize.authenticate();

  const worker = new Worker<PipelineJobData>(PIPELINE_QUEUES[stage], (job) => processStageJob(stage, job), {
    connection: createRedisConnection(),
    concurrency,
  });

  // Safety net for failures that never reached the processor (e.g. a job that stalled too often).
  // markPipelineFailed is a no-op if the processor already recorded the failure.
  worker.on('failed', (job, error) => {
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    markPipelineFailed(job.data, stage, describeFailure(error)).catch((markError: unknown) =>
      logger.error({ err: markError, ...job.data }, 'failed to mark pipeline job as failed'),
    );
  });
  worker.on('error', (error) => logger.error({ err: error, stage }, 'pipeline worker error'));

  if (env.ALLOW_FAULT_INJECTION && env.PIPELINE_FAULT_STAGE === stage) {
    logger.warn({ stage }, 'fault injection is ON: every job of this stage will fail');
  }
  logger.info({ stage, queue: PIPELINE_QUEUES[stage], concurrency }, 'pipeline service started');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, stage }, 'shutting down pipeline service');
    // close() waits for the jobs in progress; anything not started stays in the queue for other copies.
    await worker.close();
    await closeQueues();
    await sequelize.close();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
