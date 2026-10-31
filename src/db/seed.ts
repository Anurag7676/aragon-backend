/**
 * Creates (or updates) a verified test account so the app can be tried without the email-code step.
 * Credentials come from the environment, never from code:
 *
 *   SEED_USER_EMAIL=demo@photocheck.test SEED_USER_PASSWORD=... npm run db:seed
 */
import { z } from 'zod';
import { hashPassword } from '../lib/password.js';
import { logger } from '../lib/logger.js';
import { User } from './models/index.js';
import { sequelize } from './sequelize.js';

const input = z
  .object({
    SEED_USER_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
    SEED_USER_PASSWORD: z.string().min(12, 'Use at least 12 characters for the seed password.'),
  })
  .safeParse(process.env);

try {
  if (!input.success) {
    logger.error(z.flattenError(input.error).fieldErrors, 'seed: set SEED_USER_EMAIL and SEED_USER_PASSWORD');
    process.exitCode = 1;
  } else {
    const { SEED_USER_EMAIL: email, SEED_USER_PASSWORD: password } = input.data;
    const passwordHash = await hashPassword(password);
    const existing = await User.findOne({ where: { email } });

    if (existing) {
      await existing.update({ passwordHash, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() });
      logger.info({ email }, 'seed user updated');
    } else {
      await User.create({ email, passwordHash, emailVerifiedAt: new Date(), passwordChangedAt: null });
      logger.info({ email }, 'seed user created');
    }
  }
} finally {
  await sequelize.close();
}
