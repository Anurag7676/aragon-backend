import { UnrecoverableError } from 'bullmq';
import { Op, QueryTypes, type Transaction } from 'sequelize';
import { validationRules } from '../../config/rules.js';
import { Image } from '../../db/models/index.js';
import { sequelize } from '../../db/sequelize.js';
import { imageKeys, storage } from '../../integrations/s3.js';
import { logger } from '../../lib/logger.js';
import { analyzeImage } from '../../processing/analyze-image.js';
import { toSignedInt64 } from '../../processing/perceptual-hash.js';
import { publishImageEvent } from './image-events.js';
import { toImageDto } from './images.dto.js';
import type { RejectionCode } from './rejection-reasons.js';

/**
 * Validates one uploaded photo: download → analyse → store derived files → decide → notify.
 * Safe to run more than once for the same image (retries, stalled jobs, re-enqueues).
 */
export async function processImageJob(imageId: string): Promise<void> {
  const image = await Image.findByPk(imageId);
  if (!image) return; // Deleted before we got to it.
  if (image.status !== 'queued' && image.status !== 'processing') return; // Already decided.

  await image.update({ status: 'processing' });
  await publishImageEvent(image.userId, { type: 'image.updated', image: await toImageDto(image) });

  const original = await storage.getBuffer(image.originalKey);
  // A missing original will never appear on retry; other storage errors are retried by the queue.
  if (!original) throw new UnrecoverableError('Original file is missing from storage');
  const analysis = await analyzeImage(original, original.length);

  const keys = imageKeys(image.userId, image.id);
  if (analysis.display && analysis.thumbnail) {
    await Promise.all([
      storage.put(keys.display, analysis.display, 'image/jpeg'),
      storage.put(keys.thumbnail, analysis.thumbnail, 'image/webp'),
    ]);
  }
  if (!analysis.format) {
    // Not an image at all: don't keep the file.
    await storage.deleteMany([image.originalKey]);
  }

  const decided = await sequelize.transaction(async (transaction) => {
    // One decision at a time per user, so two near-identical photos processed in parallel
    // can't both see "no similar accepted photo" and both be accepted.
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:userId))', {
      replacements: { userId: image.userId },
      transaction,
    });

    const current = await Image.findByPk(image.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!current) return null;

    const reasons: RejectionCode[] = [...analysis.reasons];
    const hash = analysis.perceptualHash !== undefined ? toSignedInt64(analysis.perceptualHash).toString() : null;
    if (hash && (await hasSimilarAcceptedImage(current, hash, transaction))) reasons.push('TOO_SIMILAR');

    return current.update(
      {
        status: reasons.length === 0 ? 'accepted' : 'rejected',
        rejectionReasons: reasons,
        format: analysis.format,
        width: analysis.width,
        height: analysis.height,
        displayKey: analysis.display ? keys.display : null,
        thumbnailKey: analysis.thumbnail ? keys.thumbnail : null,
        perceptualHash: hash,
        sharpness: analysis.sharpness ?? null,
        faceCount: analysis.faceCount ?? null,
        faceSizeRatio: analysis.faceSizeRatio ?? null,
        failureReason: null,
        processedAt: new Date(),
      },
      { transaction },
    );
  });

  if (!decided) {
    // The user deleted the photo while it was processing; remove what we just wrote.
    await storage.deleteMany([keys.display, keys.thumbnail]);
    return;
  }

  logger.info(
    { imageId, status: decided.status, reasons: decided.rejectionReasons, sharpness: decided.sharpness },
    'image processed',
  );
  await publishImageEvent(decided.userId, { type: 'image.updated', image: await toImageDto(decided) });
}

/** Near-duplicate check against the user's accepted photos, by Hamming distance between 64-bit hashes. */
async function hasSimilarAcceptedImage(image: Image, hash: string, transaction: Transaction): Promise<boolean> {
  const rows = await sequelize.query(
    `SELECT 1 FROM images
     WHERE user_id = :userId
       AND status = 'accepted'
       AND perceptual_hash IS NOT NULL
       AND id <> :imageId
       AND bit_count(int8send(perceptual_hash # CAST(:hash AS bigint))) <= :maxDistance
     LIMIT 1`,
    {
      replacements: {
        userId: image.userId,
        imageId: image.id,
        hash,
        maxDistance: validationRules.maxSimilarityDistance,
      },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  return rows.length > 0;
}

/** Called once retries are exhausted. */
export async function markImageFailed(imageId: string, reason: string): Promise<void> {
  const [updated] = await Image.update(
    { status: 'failed', failureReason: reason.slice(0, 500) },
    { where: { id: imageId, status: { [Op.in]: ['queued', 'processing'] } } },
  );
  if (updated === 0) return;

  const image = await Image.findByPk(imageId);
  if (image) await publishImageEvent(image.userId, { type: 'image.updated', image: await toImageDto(image) });
}
