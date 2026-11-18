import { Op } from 'sequelize';
import { pipelineRules } from '../../config/pipeline.js';
import { PipelineJob } from '../../db/models/index.js';
import { pipelineJobState, requeuePipelineStage } from '../../integrations/queue.js';
import { logger } from '../../lib/logger.js';
import { dueStage, markPipelineFailed } from './stage-runner.js';

const BATCH_SIZE = 500;

/**
 * Finds unfinished jobs that haven't moved for a while and fixes the two ways they can get stuck:
 *  - their next stage never reached Redis (Redis was down, or a process died between saving and
 *    queueing): queue it again;
 *  - BullMQ gave up on the job without it being marked (e.g. the worker kept crashing): mark it failed.
 * Jobs that are simply waiting behind a long queue are left alone.
 */
export async function sweepStuckPipelines(): Promise<{ requeued: number; failed: number }> {
  const before = new Date(Date.now() - pipelineRules.staleMinutes * 60_000);
  const stuck = await PipelineJob.findAll({
    where: { status: { [Op.notIn]: ['completed', 'failed'] }, updatedAt: { [Op.lt]: before } },
    attributes: ['imageId', 'run', 'status'],
    limit: BATCH_SIZE,
  });

  let requeued = 0;
  let failed = 0;
  for (const job of stuck) {
    const stage = dueStage(job.status);
    if (!stage) continue;
    const data = { imageId: job.imageId, run: job.run };
    const queued = await pipelineJobState(stage, data);

    if (queued?.state === 'failed') {
      await markPipelineFailed(data, stage, {
        code: 'PROCESSING_ERROR',
        message: 'Processing stopped unexpectedly. Reprocess to try again.',
        permanent: true,
      });
      failed += 1;
    } else if (!queued || queued.state === 'completed') {
      await requeuePipelineStage(stage, data);
      requeued += 1;
    }
  }

  if (requeued > 0 || failed > 0) logger.info({ requeued, failed }, 'pipeline maintenance');
  return { requeued, failed };
}
