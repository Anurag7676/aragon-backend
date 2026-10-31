import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Image, User, type ImageStatus } from '../../src/db/models/index.js';
import { imageKeys } from '../../src/integrations/s3.js';
import { hashPassword } from '../../src/lib/password.js';
import { signAccessToken } from '../../src/modules/auth/token.service.js';

export const fixture = (name: string): Buffer => readFileSync(new URL(`../fixtures/${name}`, import.meta.url));

export const uniqueEmail = (label = 'user') => `${label}-${randomUUID().slice(0, 8)}@example.com`;

/** A verified user plus a valid access token, without going through the email flow. */
export async function createVerifiedUser(password = 'correct-horse-battery') {
  const user = await User.create({
    email: uniqueEmail(),
    passwordHash: await hashPassword(password),
    emailVerifiedAt: new Date(),
    passwordChangedAt: null,
  });
  const { token } = await signAccessToken(user.id);
  return { user, password, token, auth: { Authorization: `Bearer ${token}` } };
}

export async function createImage(
  userId: string,
  overrides: Partial<{ status: ImageStatus; createdAt: Date; rejectionReasons: string[] }> = {},
) {
  const id = randomUUID();
  return Image.create({
    id,
    userId,
    originalName: 'photo.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 100_000,
    status: overrides.status ?? 'queued',
    originalKey: imageKeys(userId, id).original,
    rejectionReasons: overrides.rejectionReasons ?? [],
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
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  });
}
