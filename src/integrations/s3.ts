import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';

// Credentials come from the default provider chain: env vars locally, the instance role on EC2.
const client = new S3Client({ region: env.AWS_REGION });

const READ_URL_WINDOW_SECONDS = 30 * 60;

export interface UploadForm {
  url: string;
  fields: Record<string, string>;
}

export const imageKeys = (userId: string, imageId: string) => {
  // Keys never contain user-supplied names.
  const base = `${env.S3_KEY_PREFIX}users/${userId}/images/${imageId}`;
  return { original: `${base}/original`, display: `${base}/display.jpg`, thumbnail: `${base}/thumbnail.webp` };
};

export const storage = {
  /**
   * Browser-to-S3 upload form. S3 itself enforces the exact key, the content type and the size range,
   * so a client cannot upload elsewhere or send a bigger file than it declared.
   */
  async createUploadForm(key: string, contentType: string, maxBytes: number, expiresInSeconds: number) {
    return createPresignedPost(client, {
      Bucket: env.S3_BUCKET,
      Key: key,
      Conditions: [
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', contentType],
      ],
      Fields: { 'Content-Type': contentType },
      Expires: expiresInSeconds,
    }) satisfies Promise<UploadForm>;
  },

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const result = await client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      return { sizeBytes: result.ContentLength ?? 0 };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null;
      throw error;
    }
  },

  /** The object's bytes, or null if it doesn't exist. Other errors (network, permissions) are thrown. */
  async getBuffer(key: string): Promise<Buffer | null> {
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      if (!result.Body) throw new Error(`Empty body for ${key}`);
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null;
      throw error;
    }
  },

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'private, max-age=31536000, immutable',
      }),
    );
  },

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await client.send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  },

  /**
   * Short-lived read URL for a private object. The signing time is rounded down to a 30-minute window
   * so the URL stays identical across requests in that window and the browser can cache the image.
   */
  async readUrl(key: string): Promise<string> {
    const windowMs = READ_URL_WINDOW_SECONDS * 1000;
    const signingDate = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    return getSignedUrl(client, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), {
      expiresIn: READ_URL_WINDOW_SECONDS * 2,
      signingDate,
    });
  },
};
