import { randomUUID } from 'node:crypto';
import { col, fn, Op, type WhereOptions } from 'sequelize';
import { uploadRules } from '../../config/rules.js';
import { Image, type ImageStatus } from '../../db/models/index.js';
import { enqueueImageProcessing } from '../../integrations/queue.js';
import { imageKeys, storage, type UploadForm } from '../../integrations/s3.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { publishImageEvent } from './image-events.js';
import { toImageDto, type ImageDto } from './images.dto.js';
import type { CreateImageInput, ListImagesQuery } from './images.schemas.js';

export interface CreatedUpload {
  image: ImageDto;
  upload: UploadForm & { expiresIn: number };
}

export interface ImagePage {
  items: ImageDto[];
  nextCursor: string | null;
}

export interface ImageSummary {
  counts: { accepted: number; rejected: number; inProgress: number; failed: number };
  minAccepted: number;
  targetAccepted: number;
}

/** Display-only file name: no path parts or control characters. */
const sanitizeFileName = (name: string) =>
  (name.split(/[\\/]/).pop() ?? 'photo')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 255) || 'photo';

/** Every lookup is scoped to the owner; another user's id behaves exactly like a missing one. */
async function findOwnedImage(userId: string, imageId: string): Promise<Image> {
  const image = await Image.findOne({ where: { id: imageId, userId } });
  if (!image) throw Errors.notFound('Photo');
  return image;
}

export const imagesService = {
  /** Step 1 of an upload: reserve the image row and return a signed form for uploading straight to S3. */
  async createUpload(userId: string, input: CreateImageInput): Promise<CreatedUpload> {
    const [total, pending] = await Promise.all([
      Image.count({ where: { userId } }),
      Image.count({ where: { userId, status: 'pending_upload' } }),
    ]);
    if (total >= uploadRules.maxImagesPerUser) {
      throw Errors.conflict(
        'PHOTO_LIMIT_REACHED',
        `You can keep up to ${uploadRules.maxImagesPerUser} photos. Delete some to upload more.`,
      );
    }
    if (pending >= uploadRules.maxPendingUploadsPerUser) {
      throw Errors.tooManyRequests('TOO_MANY_PENDING_UPLOADS', 'Wait for your current uploads to finish.');
    }

    const id = randomUUID();
    const keys = imageKeys(userId, id);
    const image = await Image.create({
      id,
      userId,
      originalName: sanitizeFileName(input.fileName),
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      status: 'pending_upload',
      originalKey: keys.original,
      format: null,
      width: null,
      height: null,
      displayKey: null,
      thumbnailKey: null,
      perceptualHash: null,
      sharpness: null,
      faceCount: null,
      faceSizeRatio: null,
      failureReason: null,
      processedAt: null,
    });

    const upload = await storage.createUploadForm(
      keys.original,
      input.contentType,
      uploadRules.maxFileBytes,
      uploadRules.uploadUrlTtlSeconds,
    );
    return { image: await toImageDto(image), upload: { ...upload, expiresIn: uploadRules.uploadUrlTtlSeconds } };
  },

  /**
   * Step 2: the browser reports the S3 upload finished. Idempotent: calling it again, or concurrently,
   * queues the image at most once.
   */
  async completeUpload(userId: string, imageId: string): Promise<ImageDto> {
    const image = await findOwnedImage(userId, imageId);
    if (image.status !== 'pending_upload') return toImageDto(image);

    const object = await storage.head(image.originalKey);
    if (!object) throw Errors.conflict('UPLOAD_NOT_FOUND', 'The file has not finished uploading yet.');

    const [updated] = await Image.update(
      { status: 'queued', sizeBytes: object.sizeBytes },
      { where: { id: image.id, userId, status: 'pending_upload' } },
    );
    if (updated === 1) {
      // If this fails the row stays "queued" and the maintenance job re-enqueues it.
      await enqueueImageProcessing(image.id).catch((error: unknown) =>
        logger.error({ err: error, imageId: image.id }, 'failed to enqueue image; maintenance will retry'),
      );
    }

    await image.reload();
    const dto = await toImageDto(image);
    await publishImageEvent(userId, { type: 'image.updated', image: dto });
    return dto;
  },

  async list(userId: string, query: ListImagesQuery): Promise<ImagePage> {
    const conditions: WhereOptions<Image>[] = [{ userId }];
    if (query.status) conditions.push({ status: { [Op.in]: query.status } });
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      // Keyset pagination: rows strictly after (createdAt, id) in descending order.
      conditions.push({
        [Op.or]: [
          { createdAt: { [Op.lt]: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { [Op.lt]: cursor.id } },
        ],
      });
    }

    const rows = await Image.findAll({
      where: { [Op.and]: conditions },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: await Promise.all(page.map(toImageDto)),
      nextCursor: rows.length > query.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    };
  },

  async get(userId: string, imageId: string): Promise<ImageDto> {
    return toImageDto(await findOwnedImage(userId, imageId));
  },

  async summary(userId: string): Promise<ImageSummary> {
    const rows = (await Image.findAll({
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      where: { userId },
      group: ['status'],
      raw: true,
    })) as unknown as { status: ImageStatus; count: string }[];

    const countOf = (...statuses: ImageStatus[]) =>
      rows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + Number(row.count), 0);

    return {
      counts: {
        accepted: countOf('accepted'),
        rejected: countOf('rejected'),
        inProgress: countOf('queued', 'processing'),
        failed: countOf('failed'),
      },
      minAccepted: uploadRules.minAcceptedPhotos,
      targetAccepted: uploadRules.targetAcceptedPhotos,
    };
  },

  /** Deletes the record first, then the files. A worker still processing it notices and cleans up. */
  async remove(userId: string, imageId: string): Promise<void> {
    const image = await findOwnedImage(userId, imageId);
    const keys = [image.originalKey, image.displayKey, image.thumbnailKey].filter((key) => key !== null);
    await image.destroy();

    await storage
      .deleteMany(keys)
      .catch((error: unknown) => logger.error({ err: error, imageId, keys }, 'failed to delete image files'));
    await publishImageEvent(userId, { type: 'image.deleted', imageId });
  },
};
