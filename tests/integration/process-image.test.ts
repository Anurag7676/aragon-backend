import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { Image } from '../../src/db/models/index.js';
import { imageKeys, storage } from '../../src/integrations/s3.js';
import { markImageFailed, processImageJob } from '../../src/modules/images/process-image.job.js';
import { createImage, createVerifiedUser, fixture } from '../helpers/factories.js';

const astronaut = fixture('astronaut.png');

async function queuedImage(userId: string, bytes: Buffer) {
  const image = await createImage(userId, { status: 'queued' });
  vi.mocked(storage.getBuffer).mockImplementation(async (key) => (key === image.originalKey ? bytes : null));
  return image;
}

describe('processImageJob', () => {
  it('accepts a good photo and stores its derived files and scores', async () => {
    const { user } = await createVerifiedUser();
    const image = await queuedImage(user.id, astronaut);

    await processImageJob(image.id);
    await image.reload();

    const keys = imageKeys(user.id, image.id);
    expect(image).toMatchObject({
      status: 'accepted',
      rejectionReasons: [],
      format: 'png',
      width: 512,
      height: 512,
      faceCount: 1,
      displayKey: keys.display,
      thumbnailKey: keys.thumbnail,
      failureReason: null,
    });
    expect(image.perceptualHash).toMatch(/^-?\d+$/);
    expect(image.sharpness).toBeGreaterThan(0);
    expect(image.processedAt).toBeInstanceOf(Date);
    expect(storage.put).toHaveBeenCalledWith(keys.display, expect.any(Buffer), 'image/jpeg');
    expect(storage.put).toHaveBeenCalledWith(keys.thumbnail, expect.any(Buffer), 'image/webp');
  });

  it("rejects a near-duplicate of the same user's accepted photo", async () => {
    const { user } = await createVerifiedUser();
    const first = await queuedImage(user.id, astronaut);
    await processImageJob(first.id);

    const recompressed = await sharp(astronaut).resize(900).jpeg({ quality: 80 }).toBuffer();
    const second = await queuedImage(user.id, recompressed);
    await processImageJob(second.id);

    await second.reload();
    expect(second.status).toBe('rejected');
    expect(second.rejectionReasons).toEqual(['TOO_SIMILAR']);
  });

  it("does not compare against other users' photos", async () => {
    const alice = await createVerifiedUser();
    const bob = await createVerifiedUser();

    const alicePhoto = await queuedImage(alice.user.id, astronaut);
    await processImageJob(alicePhoto.id);
    const bobPhoto = await queuedImage(bob.user.id, astronaut);
    await processImageJob(bobPhoto.id);

    await Promise.all([alicePhoto.reload(), bobPhoto.reload()]);
    expect(alicePhoto.status).toBe('accepted');
    expect(bobPhoto.status).toBe('accepted');
  });

  it('does not count rejected photos as existing ones', async () => {
    const { user } = await createVerifiedUser();
    const blurred = await sharp(astronaut).blur(4).jpeg({ quality: 92 }).toBuffer();
    const first = await queuedImage(user.id, blurred);
    await processImageJob(first.id);
    await first.reload();
    expect(first.status).toBe('rejected');

    const sharpCopy = await queuedImage(user.id, astronaut);
    await processImageJob(sharpCopy.id);
    await sharpCopy.reload();
    expect(sharpCopy.status).toBe('accepted');
  });

  it('accepts only one of two identical photos processed at the same time', async () => {
    const { user } = await createVerifiedUser();
    const a = await createImage(user.id, { status: 'queued' });
    const b = await createImage(user.id, { status: 'queued' });
    vi.mocked(storage.getBuffer).mockResolvedValue(astronaut);

    await Promise.all([processImageJob(a.id), processImageJob(b.id)]);
    await Promise.all([a.reload(), b.reload()]);
    expect([a.status, b.status].sort()).toEqual(['accepted', 'rejected']);
  });

  it('rejects a renamed non-image and deletes the uploaded file', async () => {
    const { user } = await createVerifiedUser();
    const image = await queuedImage(user.id, Buffer.from('MZ\x90\x00 definitely not a photo'));

    await processImageJob(image.id);
    await image.reload();

    expect(image).toMatchObject({ status: 'rejected', rejectionReasons: ['UNSUPPORTED_FORMAT'], thumbnailKey: null });
    expect(storage.put).not.toHaveBeenCalled();
    expect(storage.deleteMany).toHaveBeenCalledWith([image.originalKey]);
  });

  it('fails permanently when the original is missing from storage', async () => {
    const { user } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'queued' });
    vi.mocked(storage.getBuffer).mockResolvedValue(null);

    await expect(processImageJob(image.id)).rejects.toBeInstanceOf(UnrecoverableError);

    await markImageFailed(image.id, 'Original file is missing from storage');
    await image.reload();
    expect(image).toMatchObject({ status: 'failed', failureReason: 'Original file is missing from storage' });
  });

  it('does nothing for an image that was deleted or already decided', async () => {
    const { user } = await createVerifiedUser();
    await expect(processImageJob(randomUUID())).resolves.toBeUndefined();

    const decided = await createImage(user.id, { status: 'accepted' });
    await processImageJob(decided.id);
    expect(storage.getBuffer).not.toHaveBeenCalled();
    await decided.reload();
    expect(decided.status).toBe('accepted');
  });

  it('cleans up derived files if the photo is deleted while processing', async () => {
    const { user } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'queued' });
    vi.mocked(storage.getBuffer).mockImplementation(async () => {
      // The user deletes the photo while the worker is downloading it.
      await Image.destroy({ where: { id: image.id } });
      return astronaut;
    });

    await processImageJob(image.id);

    const keys = imageKeys(user.id, image.id);
    expect(storage.deleteMany).toHaveBeenCalledWith([keys.display, keys.thumbnail]);
    expect(await Image.findByPk(image.id)).toBeNull();
  });

  it('markImageFailed leaves decided images alone', async () => {
    const { user } = await createVerifiedUser();
    const image = await createImage(user.id, { status: 'accepted' });
    await markImageFailed(image.id, 'late failure');
    await image.reload();
    expect(image.status).toBe('accepted');
  });
});
