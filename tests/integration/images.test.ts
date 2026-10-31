import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { uploadRules } from '../../src/config/rules.js';
import { Image } from '../../src/db/models/index.js';
import { enqueueImageProcessing } from '../../src/integrations/queue.js';
import { storage } from '../../src/integrations/s3.js';
import { createImage, createVerifiedUser } from '../helpers/factories.js';

const app = createApp();
const api = () => request(app);

const validUpload = { fileName: 'selfie.heic', contentType: 'image/heic', sizeBytes: 2_500_000 };

describe('authentication', () => {
  it('rejects requests without a valid bearer token', async () => {
    await api().get('/api/v1/images').expect(401);
    await api().post('/api/v1/images').send(validUpload).expect(401);
    const res = await api().get('/api/v1/images').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});

describe('POST /images', () => {
  it('reserves a pending image and returns a signed upload form', async () => {
    const { user, auth } = await createVerifiedUser();
    const res = await api().post('/api/v1/images').set(auth).send(validUpload);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/images/${res.body.image.id}`);
    expect(res.body.image).toMatchObject({
      originalName: 'selfie.heic',
      status: 'pending_upload',
      sizeBytes: 2_500_000,
      rejectionReasons: [],
      thumbnailUrl: null,
    });
    expect(res.body.upload).toMatchObject({ url: expect.any(String), fields: expect.any(Object), expiresIn: 300 });

    const row = await Image.findByPk(res.body.image.id);
    expect(row).toMatchObject({ userId: user.id, status: 'pending_upload', contentType: 'image/heic' });
    // The S3 key is derived from ids only, never from the file name.
    expect(row!.originalKey).toBe(`test/users/${user.id}/images/${row!.id}/original`);
    expect(vi.mocked(storage.createUploadForm)).toHaveBeenCalledWith(
      row!.originalKey,
      'image/heic',
      uploadRules.maxFileBytes,
      uploadRules.uploadUrlTtlSeconds,
    );
  });

  it('strips path segments and control characters from the file name', async () => {
    const { auth } = await createVerifiedUser();
    const res = await api()
      .post('/api/v1/images')
      .set(auth)
      .send({ ...validUpload, fileName: '../../etc/pass\u0000wd‮.jpg' });
    expect(res.status).toBe(201);
    expect(res.body.image.originalName).toBe('passwd.jpg');
  });

  it.each([
    ['an unsupported type', { contentType: 'image/gif' }],
    ['a file over the size limit', { sizeBytes: uploadRules.maxFileBytes + 1 }],
    ['an empty file', { sizeBytes: 0 }],
    ['a missing file name', { fileName: '' }],
  ])('rejects %s', async (_label, override) => {
    const { auth } = await createVerifiedUser();
    const res = await api()
      .post('/api/v1/images')
      .set(auth)
      .send({ ...validUpload, ...override });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(vi.mocked(storage.createUploadForm)).not.toHaveBeenCalled();
  });

  it('limits how many uploads can be pending at once', async () => {
    const { user, auth } = await createVerifiedUser();
    await Promise.all(
      Array.from({ length: uploadRules.maxPendingUploadsPerUser }, () =>
        createImage(user.id, { status: 'pending_upload' }),
      ),
    );
    const res = await api().post('/api/v1/images').set(auth).send(validUpload);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_PENDING_UPLOADS');
  });
});

describe('POST /images/:id/complete', () => {
  it('refuses to queue an image whose file is not in storage yet', async () => {
    const { user, auth } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'pending_upload' });
    vi.mocked(storage.head).mockResolvedValueOnce(null);

    const res = await api().post(`/api/v1/images/${image.id}/complete`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UPLOAD_NOT_FOUND');
    expect(enqueueImageProcessing).not.toHaveBeenCalled();
    await image.reload();
    expect(image.status).toBe('pending_upload');
  });

  it('queues the image once, using the size reported by storage, even when called twice', async () => {
    const { user, auth } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'pending_upload' });

    const [first, second] = await Promise.all([
      api().post(`/api/v1/images/${image.id}/complete`).set(auth),
      api().post(`/api/v1/images/${image.id}/complete`).set(auth),
    ]);
    const third = await api().post(`/api/v1/images/${image.id}/complete`).set(auth);

    for (const res of [first, second, third]) {
      expect(res.status).toBe(202);
      expect(res.body.image.status).toBe('queued');
    }
    expect(enqueueImageProcessing).toHaveBeenCalledTimes(1);
    expect(enqueueImageProcessing).toHaveBeenCalledWith(image.id);
    await image.reload();
    expect(image.sizeBytes).toBe(123_456);
  });

  it('still marks the image queued if Redis is unavailable (maintenance re-enqueues it)', async () => {
    const { user, auth } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'pending_upload' });
    vi.mocked(enqueueImageProcessing).mockRejectedValueOnce(new Error('redis down'));

    const res = await api().post(`/api/v1/images/${image.id}/complete`).set(auth);
    expect(res.status).toBe(202);
    expect(res.body.image.status).toBe('queued');
  });
});

describe('GET /images', () => {
  let auth: Record<string, string>;
  let accepted: Image[];

  beforeAll(async () => {
    const owner = await createVerifiedUser();
    auth = owner.auth;
    const base = Date.now() - 60 * 60_000;
    accepted = [];
    for (let i = 0; i < 5; i++) {
      accepted.push(await createImage(owner.user.id, { status: 'accepted', createdAt: new Date(base + i * 1000) }));
    }
    await createImage(owner.user.id, { status: 'rejected', rejectionReasons: ['BLURRY', 'NOT_A_REAL_CODE'] });
    await createImage(owner.user.id, { status: 'processing' });
    await createImage(owner.user.id, { status: 'failed' });
  });

  it('filters by status and pages newest first with a cursor', async () => {
    const page1 = await api().get('/api/v1/images?status=accepted&limit=2').set(auth);
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((item: { id: string }) => item.id)).toEqual([accepted[4]!.id, accepted[3]!.id]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await api().get(`/api/v1/images?status=accepted&limit=2&cursor=${page1.body.nextCursor}`).set(auth);
    expect(page2.body.items.map((item: { id: string }) => item.id)).toEqual([accepted[2]!.id, accepted[1]!.id]);

    const page3 = await api().get(`/api/v1/images?status=accepted&limit=2&cursor=${page2.body.nextCursor}`).set(auth);
    expect(page3.body.items.map((item: { id: string }) => item.id)).toEqual([accepted[0]!.id]);
    expect(page3.body.nextCursor).toBeNull();
  });

  it('accepts several statuses and returns readable rejection reasons', async () => {
    const res = await api().get('/api/v1/images?status=rejected,failed').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { status: string }) => item.status).sort()).toEqual(['failed', 'rejected']);

    const rejected = res.body.items.find((item: { status: string }) => item.status === 'rejected');
    // Unknown codes are dropped rather than shown raw.
    expect(rejected.rejectionReasons).toEqual([
      { code: 'BLURRY', label: 'Blurry face detected', message: expect.any(String) },
    ]);
  });

  it('validates query parameters', async () => {
    expect((await api().get('/api/v1/images?status=deleted').set(auth)).status).toBe(400);
    expect((await api().get('/api/v1/images?limit=1000').set(auth)).status).toBe(400);
    const badCursor = await api().get('/api/v1/images?cursor=not-a-cursor').set(auth);
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe('INVALID_CURSOR');
  });

  it('summarises counts by status with the photo targets', async () => {
    const res = await api().get('/api/v1/images/summary').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      counts: { accepted: 5, rejected: 1, inProgress: 1, failed: 1 },
      minAccepted: uploadRules.minAcceptedPhotos,
      targetAccepted: uploadRules.targetAcceptedPhotos,
    });
  });
});

describe('ownership', () => {
  it("hides one user's photos from another user completely", async () => {
    const owner = await createVerifiedUser();
    const stranger = await createVerifiedUser();
    const image = await createImage(owner.user.id, { status: 'pending_upload' });

    await api().get(`/api/v1/images/${image.id}`).set(stranger.auth).expect(404);
    await api().post(`/api/v1/images/${image.id}/complete`).set(stranger.auth).expect(404);
    await api().delete(`/api/v1/images/${image.id}`).set(stranger.auth).expect(404);

    const list = await api().get('/api/v1/images').set(stranger.auth);
    expect(list.body.items).toEqual([]);
    const summary = await api().get('/api/v1/images/summary').set(stranger.auth);
    expect(summary.body.counts).toEqual({ accepted: 0, rejected: 0, inProgress: 0, failed: 0 });

    // Untouched for the owner.
    await image.reload();
    expect(image.status).toBe('pending_upload');
    expect(enqueueImageProcessing).not.toHaveBeenCalled();
    expect(storage.deleteMany).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown ids and 400 for malformed ones', async () => {
    const { auth } = await createVerifiedUser();
    await api().get(`/api/v1/images/${randomUUID()}`).set(auth).expect(404);
    const malformed = await api().get('/api/v1/images/not-a-uuid').set(auth);
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /images/:id', () => {
  it('deletes the record and all of its files', async () => {
    const { user, auth } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'accepted' });
    await image.update({ displayKey: 'display-key', thumbnailKey: 'thumb-key' });

    await api().delete(`/api/v1/images/${image.id}`).set(auth).expect(204);
    await api().get(`/api/v1/images/${image.id}`).set(auth).expect(404);
    expect(await Image.findByPk(image.id)).toBeNull();
    expect(storage.deleteMany).toHaveBeenCalledWith([image.originalKey, 'display-key', 'thumb-key']);
  });

  it('still succeeds when file clean-up fails', async () => {
    const { user, auth } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'rejected' });
    vi.mocked(storage.deleteMany).mockRejectedValueOnce(new Error('S3 unavailable'));

    await api().delete(`/api/v1/images/${image.id}`).set(auth).expect(204);
    expect(await Image.findByPk(image.id)).toBeNull();
  });
});
