import { Op } from 'sequelize';
import { uploadRules } from '../../config/rules.js';
import { Image } from '../../db/models/index.js';
import { enqueueImageProcessing } from '../../integrations/queue.js';
import { storage } from '../../integrations/s3.js';
import { logger } from '../../lib/logger.js';

const BATCH_SIZE = 500;

/**
 * Periodic clean-up:
 *  1. Uploads that were started but never completed (the browser closed, the upload failed).
 *  2. Images marked queued whose job never reached Redis (e.g. Redis was briefly down).
 */
export async function runUploadMaintenance(): Promise<void> {
  const abandonedBefore = new Date(Date.now() - uploadRules.pendingUploadExpiryMinutes * 60_000);
  const abandoned = await Image.findAll({
    where: { status: 'pending_upload', updatedAt: { [Op.lt]: abandonedBefore } },
    attributes: ['id', 'originalKey'],
    limit: BATCH_SIZE,
  });
  if (abandoned.length > 0) {
    await storage.deleteMany(abandoned.map((image) => image.originalKey));
    await Image.destroy({ where: { id: abandoned.map((image) => image.id), status: 'pending_upload' } });
  }

  const staleBefore = new Date(Date.now() - uploadRules.staleQueuedMinutes * 60_000);
  const stale = await Image.findAll({
    where: { status: 'queued', updatedAt: { [Op.lt]: staleBefore } },
    attributes: ['id'],
    limit: BATCH_SIZE,
  });
  // The job id is the image id, so this is a no-op for images that are already in the queue.
  await Promise.all(stale.map((image) => enqueueImageProcessing(image.id)));

  if (abandoned.length > 0 || stale.length > 0) {
    logger.info({ removedAbandoned: abandoned.length, requeued: stale.length }, 'upload maintenance');
  }
}
