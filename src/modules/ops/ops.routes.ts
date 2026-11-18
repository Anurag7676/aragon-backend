import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { col, fn, Op, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { Image, PIPELINE_STATUSES, PipelineJob, type ImageStatus, type PipelineStatus } from '../../db/models/index.js';
import { getQueueStats } from '../../integrations/queue.js';
import { Errors } from '../../lib/errors.js';

/**
 * Operator-only view of the pipeline (queue depth, consumers per queue, jobs by status), used by the
 * load test and for watching it scale. It returns counts only, never user data, and is switched off
 * unless OPS_TOKEN is set.
 */
export const opsRouter = Router();

const digest = (value: string) => createHash('sha256').update(value).digest();

function requireOpsToken(req: Request, _res: Response, next: NextFunction): void {
  if (!env.OPS_TOKEN) return next('router'); // Off: behaves like an unknown route.
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  // Comparing fixed-length digests keeps the check constant-time whatever the input length.
  if (!token || !timingSafeEqual(digest(token), digest(env.OPS_TOKEN))) {
    return next(Errors.unauthorized('A valid operations token is required.'));
  }
  next();
}

const statsQuerySchema = z.object({ since: z.iso.datetime().optional() });

opsRouter.use(requireOpsToken);

opsRouter.get('/pipeline', async (req, res) => {
  const { since } = statsQuerySchema.parse(req.query);
  const sinceDate = since ? new Date(since) : undefined;
  const jobsWhere: WhereOptions<PipelineJob> = sinceDate ? { queuedAt: { [Op.gte]: sinceDate } } : {};
  const imagesWhere: WhereOptions<Image> = {
    status: ['queued', 'processing'],
    ...(sinceDate ? { createdAt: { [Op.gte]: sinceDate } } : {}),
  };

  const [queues, jobRows, imageRows] = await Promise.all([
    getQueueStats(),
    PipelineJob.findAll({
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      where: jobsWhere,
      group: ['status'],
      raw: true,
    }) as unknown as Promise<{ status: PipelineStatus; count: string }[]>,
    Image.findAll({
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      where: imagesWhere,
      group: ['status'],
      raw: true,
    }) as unknown as Promise<{ status: ImageStatus; count: string }[]>,
  ]);

  const jobs = Object.fromEntries(PIPELINE_STATUSES.map((status) => [status, 0])) as Record<PipelineStatus, number>;
  for (const row of jobRows) jobs[row.status] = Number(row.count);
  const validating = imageRows.reduce((sum, row) => sum + Number(row.count), 0);

  res.json({ at: new Date().toISOString(), since: since ?? null, queues, jobs, validating });
});
