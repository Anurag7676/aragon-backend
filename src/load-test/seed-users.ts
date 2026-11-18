/**
 * Creates verified load-test accounts and prints a JSON list of { email, token } to stdout for the
 * load-test runner. It runs where the secrets live (locally, or inside the API container on the
 * server), so tokens are signed directly instead of logging in 50+ times through the rate-limited API.
 *
 *   LOG_LEVEL=silent node dist/load-test/seed-users.js --users 84 > tokens.json
 *
 * Nobody can log in to these accounts with a password: each gets a random one that is never stored.
 * Remove them afterwards with dist/load-test/cleanup.js.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { User } from '../db/models/index.js';
import { sequelize } from '../db/sequelize.js';
import { hashPassword } from '../lib/password.js';
import { signAccessToken } from '../modules/auth/token.service.js';
import { loadTestEmail } from './load-test-users.js';

const { values } = parseArgs({
  options: {
    users: { type: 'string', default: '84' },
    'token-ttl-minutes': { type: 'string', default: '120' },
  },
});

const count = Number(values.users);
const ttlSeconds = Number(values['token-ttl-minutes']) * 60;
if (!Number.isInteger(count) || count < 1 || count > 1_000) throw new Error('--users must be between 1 and 1000');

try {
  const runId = randomUUID().slice(0, 8);
  // One hash for all accounts: hashing is deliberately slow, and the password is thrown away.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  const users = await User.bulkCreate(
    Array.from({ length: count }, (_, index) => ({
      email: loadTestEmail(runId, index),
      passwordHash,
      emailVerifiedAt: new Date(),
      passwordChangedAt: null,
    })),
  );
  const tokens = await Promise.all(
    users.map(async (user) => ({ email: user.email, token: (await signAccessToken(user.id, ttlSeconds)).token })),
  );
  process.stdout.write(`${JSON.stringify({ runId, users: tokens }, null, 2)}\n`);
} finally {
  await sequelize.close();
}
