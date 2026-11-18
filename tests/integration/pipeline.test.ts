import { S3ServiceException } from '@aws-sdk/client-s3';
import { UnrecoverableError, type Job } from 'bullmq';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import type { PipelineStage } from '../../src/config/pipeline.js';
import { Image, ImageVariant, PipelineJob } from '../../src/db/models/index.js';
import { sequelize } from '../../src/db/sequelize.js';
import {
  enqueuePipelineStage,
  getQueueStats,
  pipelineJobState,
  requeuePipelineStage,
  type PipelineJobData,
} from '../../src/integrations/queue.js';
import { imageKeys, pipelineKeys, storage } from '../../src/integrations/s3.js';
import { processImageJob } from '../../src/modules/images/process-image.job.js';
import { sweepStuckPipelines } from '../../src/modules/pipeline/pipeline-maintenance.job.js';
import { processStageJob, runStage } from '../../src/modules/pipeline/stage-runner.js';
import { createImage, createVerifiedUser, fixture } from '../helpers/factories.js';

const api = () => request(createApp());
const astronaut = fixture('astronaut.png');
const heic = fixture('example.heic');

/** In-memory S3 plus a local queue, so a whole pipeline run happens inside one test. */
let bucket: Map<string, Buffer>;
let queued: { stage: PipelineStage; data: PipelineJobData }[];

beforeEach(() => {
  bucket = new Map();
  queued = [];
  vi.mocked(storage.put).mockImplementation(async (key, body) => void bucket.set(key, body));
  vi.mocked(storage.getBuffer).mockImplementation(async (key) => bucket.get(key) ?? null);
  vi.mocked(storage.deleteMany).mockImplementation(async (keys) => keys.forEach((key) => bucket.delete(key)));
  vi.mocked(storage.readUrl).mockImplementation(async (key) => `https://s3.test/read/${key}`);
  vi.mocked(enqueuePipelineStage).mockImplementation(async (stage, data) => {
    queued.push({ stage, data });
    return {} as never;
  });
});

/** Runs every queued stage job until the queue is empty, like the three services would. */
async function drain(): Promise<void> {
  for (let next = queued.shift(); next; next = queued.shift()) await runStage(next.stage, next.data);
}

const fakeJob = (data: PipelineJobData, attemptsMade = 0) =>
  ({ data, attemptsMade, opts: { attempts: 3 } }) as unknown as Job<PipelineJobData>;

/** An accepted photo whose pipeline job is queued, as validation leaves it. */
async function acceptedImage(userId: string, original: Buffer = astronaut) {
  const image = await createImage(userId, { status: 'accepted' });
  bucket.set(image.originalKey, original);
  const job = await PipelineJob.create({ imageId: image.id, queuedAt: new Date() });
  queued.push({ stage: 'conversion', data: { imageId: image.id, run: job.run } });
  return { image, job };
}

describe('from validation into the pipeline', () => {
  it('creates a queued job and queues conversion when a photo is accepted', async () => {
    const { user } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'queued' });
    bucket.set(image.originalKey, astronaut);

    await processImageJob(image.id);

    const job = await PipelineJob.findOne({ where: { imageId: image.id } });
    expect(job).toMatchObject({ status: 'queued', run: 1 });
    expect(queued).toEqual([{ stage: 'conversion', data: { imageId: image.id, run: 1 } }]);
  });

  it('does not start the pipeline for a rejected photo', async () => {
    const { user } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'queued' });
    bucket.set(image.originalKey, await sharp(astronaut).blur(4).jpeg().toBuffer());

    await processImageJob(image.id);

    expect(await PipelineJob.count({ where: { imageId: image.id } })).toBe(0);
    expect(queued).toEqual([]);
  });
});

describe('a full pipeline run', () => {
  it('converts, compresses and stores three variants with their metadata', async () => {
    const { user } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id);

    await drain();

    const job = await PipelineJob.findOne({ where: { imageId: image.id } });
    expect(job).toMatchObject({ status: 'completed', sourceFormat: 'png', width: 512, height: 512, errorCode: null });
    expect(job!.compressedBytes).toBeLessThan(job!.convertedBytes!);
    expect(job!.compressionRatio).toBeGreaterThan(1);
    expect(job!.completedAt).toBeInstanceOf(Date);

    const keys = imageKeys(user.id, image.id);
    const variants = await ImageVariant.findAll({ where: { imageId: image.id }, order: [['kind', 'ASC']] });
    expect(variants.map((variant) => [variant.kind, variant.s3Key, variant.run])).toEqual([
      ['thumbnail', keys.variants.thumbnail, 1],
      ['web', keys.variants.web, 1],
      ['full', keys.variants.full, 1],
    ]);
    expect(variants[0]).toMatchObject({ width: 256, height: 256, format: 'jpeg', contentType: 'image/jpeg' });
    expect(variants[0]!.url).toBe(`https://test-bucket.s3.ap-southeast-1.amazonaws.com/${keys.variants.thumbnail}`);
    for (const variant of variants) expect(bucket.get(variant.s3Key)?.length).toBe(variant.bytes);

    // The intermediates are removed once the variants exist.
    expect(bucket.has(keys.converted)).toBe(false);
    expect(bucket.has(keys.compressed)).toBe(false);
  });

  it('converts a HEIC original into JPEG variants', async () => {
    const { user } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id, heic);

    await drain();

    const job = await PipelineJob.findOne({ where: { imageId: image.id } });
    expect(job).toMatchObject({ status: 'completed', sourceFormat: 'heic' });
    const full = bucket.get(imageKeys(user.id, image.id).variants.full)!;
    expect((await sharp(full).metadata()).format).toBe('jpeg');
  });

  it('reports each stage through the API, with timings, and lists the variants', async () => {
    const { user, auth } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id);

    const before = await api().get(`/api/v1/images/${image.id}/pipeline`).set(auth).expect(200);
    expect(before.body.pipeline).toMatchObject({ status: 'queued', run: 1, error: null });

    await drain();

    const after = await api().get(`/api/v1/images/${image.id}/pipeline`).set(auth).expect(200);
    expect(after.body.pipeline).toMatchObject({ status: 'completed', sourceFormat: 'png', error: null });
    expect(after.body.pipeline.savedPercent).toBeGreaterThan(0);
    for (const stage of ['conversion', 'compression', 'variants']) {
      expect(after.body.pipeline.durations[stage].runMs).toBeGreaterThanOrEqual(0);
    }

    const variants = await api().get(`/api/v1/images/${image.id}/variants`).set(auth).expect(200);
    expect(variants.body.status).toBe('completed');
    expect(variants.body.variants.map((variant: { kind: string }) => variant.kind)).toEqual(['thumbnail', 'web', 'full']);
    expect(variants.body.variants[0]).toMatchObject({
      url: `https://s3.test/read/${imageKeys(user.id, image.id).variants.thumbnail}`,
      width: 256,
      height: 256,
      run: 1,
    });

    const listed = await api().get(`/api/v1/images/${image.id}`).set(auth).expect(200);
    expect(listed.body.image.pipeline).toEqual({ status: 'completed', run: 1, error: null });
  });

  it("hides another user's pipeline", async () => {
    const owner = await createVerifiedUser();
    const other = await createVerifiedUser();
    const { image } = await acceptedImage(owner.user.id);

    await api().get(`/api/v1/images/${image.id}/pipeline`).set(other.auth).expect(404);
    await api().get(`/api/v1/images/${image.id}/variants`).set(other.auth).expect(404);
    await api().post(`/api/v1/images/${image.id}/reprocess`).set(other.auth).expect(404);
  });
});

describe('repeat deliveries and stale jobs', () => {
  it('ignores a job from an older run', async () => {
    const { user } = await createVerifiedUser();
    const { image, job } = await acceptedImage(user.id);
    await job.update({ run: 2 });

    await runStage('conversion', { imageId: image.id, run: 1 });

    await job.reload();
    expect(job.status).toBe('queued');
    expect(storage.getBuffer).not.toHaveBeenCalled();
  });

  it('does not redo a finished stage, but makes sure the next one is queued', async () => {
    const { user } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id);
    const conversion = queued.shift()!;
    await runStage(conversion.stage, conversion.data);
    expect(queued.map((job) => job.stage)).toEqual(['compression']);
    vi.mocked(storage.getBuffer).mockClear();

    // The same conversion job delivered again, e.g. after the worker crashed before acknowledging it.
    await runStage(conversion.stage, conversion.data);

    expect(storage.getBuffer).not.toHaveBeenCalled();
    expect(queued.map((job) => job.stage)).toEqual(['compression', 'compression']);
    await drain();
    expect(await ImageVariant.count({ where: { imageId: image.id } })).toBe(3);
  });

  it('keeps three variants when the variant stage runs twice at once', async () => {
    const { user } = await createVerifiedUser();
    const { image, job } = await acceptedImage(user.id);
    queued.shift();
    await runStage('conversion', { imageId: image.id, run: job.run });
    await runStage('compression', { imageId: image.id, run: job.run });
    queued.length = 0;

    await Promise.all([
      runStage('variants', { imageId: image.id, run: job.run }),
      runStage('variants', { imageId: image.id, run: job.run }),
    ]);

    await job.reload();
    expect(job.status).toBe('completed');
    expect(await ImageVariant.count({ where: { imageId: image.id } })).toBe(3);
  });
});

describe('POST /images/:id/reprocess', () => {
  it('runs the pipeline again without duplicating variants', async () => {
    const { user, auth } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id);
    await drain();
    const firstIds = (await ImageVariant.findAll({ where: { imageId: image.id } })).map((variant) => variant.id).sort();

    const res = await api().post(`/api/v1/images/${image.id}/reprocess`).set(auth).expect(202);
    expect(res.body.pipeline).toMatchObject({ status: 'queued', run: 2, error: null, compressionRatio: null });
    expect(queued).toEqual([{ stage: 'conversion', data: { imageId: image.id, run: 2 } }]);

    await drain();
    // And once more, to be sure repeated reprocessing stays stable.
    await api().post(`/api/v1/images/${image.id}/reprocess`).set(auth).expect(202);
    await drain();

    const job = await PipelineJob.findOne({ where: { imageId: image.id } });
    expect(job).toMatchObject({ status: 'completed', run: 3 });
    const variants = await ImageVariant.findAll({ where: { imageId: image.id } });
    expect(variants).toHaveLength(3);
    expect(variants.map((variant) => variant.id).sort()).toEqual(firstIds);
    expect(variants.every((variant) => variant.run === 3)).toBe(true);
    // Same three files, overwritten in place.
    expect([...bucket.keys()].filter((key) => key.includes('/variants/')).sort()).toEqual(
      Object.values(imageKeys(user.id, image.id).variants).sort(),
    );
  });

  it('refuses while a run is in progress', async () => {
    const { user, auth } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id);

    const res = await api().post(`/api/v1/images/${image.id}/reprocess`).set(auth).expect(409);
    expect(res.body.error.code).toBe('PIPELINE_BUSY');
  });

  it('starts exactly one run when two requests arrive together', async () => {
    const { user, auth } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id);
    await drain();

    const responses = await Promise.all([
      api().post(`/api/v1/images/${image.id}/reprocess`).set(auth),
      api().post(`/api/v1/images/${image.id}/reprocess`).set(auth),
    ]);

    expect(responses.map((res) => res.status).sort()).toEqual([202, 409]);
    expect(queued).toHaveLength(1);
    expect((await PipelineJob.findOne({ where: { imageId: image.id } }))!.run).toBe(2);
  });

  it('starts the first run for a photo accepted before the pipeline existed', async () => {
    const { user, auth } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'accepted' });

    const res = await api().post(`/api/v1/images/${image.id}/reprocess`).set(auth).expect(202);
    expect(res.body.pipeline).toMatchObject({ status: 'queued', run: 1 });
    expect(queued).toEqual([{ stage: 'conversion', data: { imageId: image.id, run: 1 } }]);
  });

  it('refuses photos that were not accepted', async () => {
    const { user, auth } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'rejected' });

    const res = await api().post(`/api/v1/images/${image.id}/reprocess`).set(auth).expect(409);
    expect(res.body.error.code).toBe('NOT_ACCEPTED');
  });
});

describe('failures', () => {
  afterEach(() => {
    env.ALLOW_FAULT_INJECTION = false;
    env.PIPELINE_FAULT_STAGE = undefined;
  });

  it('stops at once with a clear reason when the original is missing', async () => {
    const { user, auth } = await createVerifiedUser();
    const { image, job } = await acceptedImage(user.id);
    bucket.delete(image.originalKey);

    await expect(processStageJob('conversion', fakeJob({ imageId: image.id, run: job.run }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const res = await api().get(`/api/v1/images/${image.id}/pipeline`).set(auth).expect(200);
    expect(res.body.pipeline).toMatchObject({
      status: 'failed',
      error: { stage: 'conversion', code: 'SOURCE_MISSING', message: 'The original upload is missing from storage.' },
    });
    expect(res.body.pipeline.timings.failedAt).toEqual(expect.any(String));
  });

  it('retries temporary storage errors and records them only after the last attempt', async () => {
    const { user } = await createVerifiedUser();
    const { image, job } = await acceptedImage(user.id);
    const outage = new S3ServiceException({
      name: 'InternalError',
      $fault: 'server',
      $metadata: { httpStatusCode: 500 },
      message: 'We encountered an internal error.',
    });
    vi.mocked(storage.getBuffer).mockRejectedValue(outage);
    const data = { imageId: image.id, run: job.run };

    // First attempt: rethrown as-is so BullMQ retries it; the job is not failed yet.
    await expect(processStageJob('conversion', fakeJob(data, 0))).rejects.toBe(outage);
    await job.reload();
    expect(job.status).toBe('converting');

    // Last attempt: recorded with a safe message, and BullMQ is told to stop.
    await expect(processStageJob('conversion', fakeJob(data, 2))).rejects.toBeInstanceOf(UnrecoverableError);
    await job.reload();
    expect(job).toMatchObject({ status: 'failed', failedStage: 'conversion', errorCode: 'STORAGE_ERROR' });
    expect(job.errorMessage).not.toContain('internal error');
  });

  it('fails a stage on purpose with fault injection, then succeeds on reprocess', async () => {
    const { user, auth } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id);
    env.ALLOW_FAULT_INJECTION = true;
    env.PIPELINE_FAULT_STAGE = 'compression';

    const conversion = queued.shift()!;
    await processStageJob(conversion.stage, fakeJob(conversion.data));
    const compression = queued.shift()!;
    await expect(processStageJob(compression.stage, fakeJob(compression.data))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const failed = await api().get(`/api/v1/images/${image.id}/pipeline`).set(auth).expect(200);
    expect(failed.body.pipeline).toMatchObject({
      status: 'failed',
      error: { stage: 'compression', code: 'INJECTED_FAILURE' },
    });

    env.ALLOW_FAULT_INJECTION = false;
    await api().post(`/api/v1/images/${image.id}/reprocess`).set(auth).expect(202);
    await drain();

    const fixed = await api().get(`/api/v1/images/${image.id}/variants`).set(auth).expect(200);
    expect(fixed.body).toMatchObject({ status: 'completed', run: 2, error: null });
    expect(fixed.body.variants).toHaveLength(3);
  });

  it('ignores the fault setting unless it is explicitly allowed', async () => {
    const { user } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id);
    env.PIPELINE_FAULT_STAGE = 'conversion';

    await drain();

    expect((await PipelineJob.findOne({ where: { imageId: image.id } }))!.status).toBe('completed');
  });

  it('cleans up its files when the photo is deleted mid-pipeline', async () => {
    const { user } = await createVerifiedUser();
    const { image } = await acceptedImage(user.id);
    const keys = imageKeys(user.id, image.id);
    vi.mocked(storage.getBuffer).mockImplementation(async (key) => {
      // The user deletes the photo while compression is downloading the converted file.
      if (key === keys.converted) await Image.destroy({ where: { id: image.id } });
      return bucket.get(key) ?? null;
    });

    await drain();

    expect(await PipelineJob.count({ where: { imageId: image.id } })).toBe(0);
    expect(storage.deleteMany).toHaveBeenCalledWith(pipelineKeys(user.id, image.id));
    expect(bucket.has(keys.compressed)).toBe(false);
  });
});

describe('maintenance sweep', () => {
  async function stuckJob(userId: string, status: 'queued' | 'compressing') {
    const { image, job } = await acceptedImage(userId);
    await job.update({ status });
    await sequelize.query("UPDATE pipeline_jobs SET updated_at = now() - interval '30 minutes' WHERE id = :id", {
      replacements: { id: job.id },
    });
    return { image, job };
  }

  it('re-queues a job whose next stage never reached Redis', async () => {
    const { user } = await createVerifiedUser();
    const { image, job } = await stuckJob(user.id, 'compressing');
    vi.mocked(pipelineJobState).mockResolvedValue(null);

    await sweepStuckPipelines();

    expect(requeuePipelineStage).toHaveBeenCalledWith('compression', { imageId: image.id, run: job.run });
  });

  it('marks a job failed when BullMQ already gave up on it', async () => {
    const { user } = await createVerifiedUser();
    const { image } = await stuckJob(user.id, 'queued');
    vi.mocked(pipelineJobState).mockResolvedValue({ state: 'failed', failedReason: 'job stalled more than allowable limit' });

    await sweepStuckPipelines();

    const job = await PipelineJob.findOne({ where: { imageId: image.id } });
    expect(job).toMatchObject({ status: 'failed', failedStage: 'conversion', errorCode: 'PROCESSING_ERROR' });
  });

  it('leaves jobs that are just waiting in a long queue', async () => {
    const { user } = await createVerifiedUser();
    const { image } = await stuckJob(user.id, 'queued');
    vi.mocked(pipelineJobState).mockResolvedValue({ state: 'waiting', failedReason: undefined });

    await sweepStuckPipelines();

    expect(requeuePipelineStage).not.toHaveBeenCalled();
    expect((await PipelineJob.findOne({ where: { imageId: image.id } }))!.status).toBe('queued');
  });
});

describe('GET /ops/pipeline', () => {
  const token = 'ops-token-that-is-long-enough-for-the-schema-0123';
  afterEach(() => {
    env.OPS_TOKEN = undefined;
  });

  it('does not exist unless OPS_TOKEN is set', async () => {
    await api().get('/api/v1/ops/pipeline').set('Authorization', `Bearer ${token}`).expect(404);
  });

  it('needs the right token', async () => {
    env.OPS_TOKEN = token;
    await api().get('/api/v1/ops/pipeline').expect(401);
    await api().get('/api/v1/ops/pipeline').set('Authorization', 'Bearer wrong').expect(401);
    const { auth } = await createVerifiedUser();
    await api().get('/api/v1/ops/pipeline').set(auth).expect(401); // a user token is not an ops token
  });

  it('returns queue depth and job counts', async () => {
    env.OPS_TOKEN = token;
    const since = new Date().toISOString();
    const { user } = await createVerifiedUser();
    await acceptedImage(user.id);
    vi.mocked(getQueueStats).mockResolvedValue({
      validation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, workers: 1 },
      conversion: { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 0, workers: 2 },
      compression: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, workers: 1 },
      variants: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, workers: 3 },
    });

    const res = await api().get(`/api/v1/ops/pipeline?since=${since}`).set('Authorization', `Bearer ${token}`).expect(200);

    expect(res.body.queues.variants.workers).toBe(3);
    expect(res.body.jobs).toMatchObject({ queued: 1, completed: 0 });
  });
});
