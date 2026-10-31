import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { Op, type Transaction } from 'sequelize';
import { env } from '../../config/env.js';
import { RefreshToken } from '../../db/models/index.js';
import { sequelize } from '../../db/sequelize.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';

const ISSUER = 'aragon-api';
const AUDIENCE = 'aragon-web';
const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

/** Two tabs refreshing at the same moment both present the old token; don't treat that as theft. */
const REUSE_GRACE_MS = 10_000;

export interface ClientMeta {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export async function signAccessToken(userId: string): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(accessSecret);
  return { token, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS };
}

export async function verifyAccessToken(token: string): Promise<{ userId: string }> {
  const { payload } = await jwtVerify(token, accessSecret, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ['HS256'],
  });
  if (!payload.sub) throw new Error('Token has no subject');
  return { userId: payload.sub };
}

export async function createRefreshToken(
  userId: string,
  meta: ClientMeta,
  options: { familyId?: string; transaction?: Transaction } = {},
): Promise<IssuedRefreshToken & { id: string }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60_000);
  const record = await RefreshToken.create(
    {
      userId,
      familyId: options.familyId ?? randomUUID(),
      tokenHash: sha256Hex(token),
      expiresAt,
      revokedAt: null,
      replacedById: null,
      userAgent: meta.userAgent?.slice(0, 255) ?? null,
      ipAddress: meta.ipAddress?.slice(0, 64) ?? null,
    },
    { transaction: options.transaction ?? null },
  );
  return { id: record.id, token, expiresAt };
}

export type RotationResult =
  | { ok: true; userId: string; refreshToken: IssuedRefreshToken }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reused' };

/**
 * Exchanges a refresh token for a new one (rotation). Presenting a token that was already rotated
 * means it may have been stolen, so the whole family (that login session) is revoked.
 */
export async function rotateRefreshToken(rawToken: string, meta: ClientMeta): Promise<RotationResult> {
  return sequelize.transaction(async (transaction): Promise<RotationResult> => {
    const current = await RefreshToken.findOne({
      where: { tokenHash: sha256Hex(rawToken) },
      lock: transaction.LOCK.UPDATE,
      transaction,
    });
    if (!current) return { ok: false, reason: 'unknown' };

    if (current.revokedAt) {
      const recentlyRotated =
        current.replacedById !== null && Date.now() - current.revokedAt.getTime() < REUSE_GRACE_MS;
      if (recentlyRotated) return { ok: false, reason: 'revoked' };
      await revokeFamily(current.familyId, transaction);
      return { ok: false, reason: 'reused' };
    }

    if (current.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

    const next = await createRefreshToken(current.userId, meta, { familyId: current.familyId, transaction });
    await current.update({ revokedAt: new Date(), replacedById: next.id }, { transaction });
    return { ok: true, userId: current.userId, refreshToken: { token: next.token, expiresAt: next.expiresAt } };
  });
}

async function revokeFamily(familyId: string, transaction?: Transaction): Promise<void> {
  await RefreshToken.update(
    { revokedAt: new Date() },
    { where: { familyId, revokedAt: { [Op.is]: null } }, transaction: transaction ?? null },
  );
}

/** Logout: revokes the session the token belongs to. Unknown tokens are ignored. */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const record = await RefreshToken.findOne({ where: { tokenHash: sha256Hex(rawToken) } });
  if (record) await revokeFamily(record.familyId);
}

/** Signs the user out everywhere, e.g. after a password reset. */
export async function revokeAllRefreshTokens(userId: string, transaction?: Transaction): Promise<void> {
  await RefreshToken.update(
    { revokedAt: new Date() },
    { where: { userId, revokedAt: { [Op.is]: null } }, transaction: transaction ?? null },
  );
}
