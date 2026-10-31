import { Sequelize } from 'sequelize';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const sequelize = new Sequelize(env.DATABASE_URL, {
  dialect: 'postgres',
  logging: (sql) => logger.trace({ sql }, 'sql'),
  dialectOptions: env.DATABASE_SSL ? { ssl: { require: true, rejectUnauthorized: true } } : {},
  pool: { max: env.DATABASE_POOL_MAX, min: 0, idle: 10_000, acquire: 30_000 },
  define: { underscored: true },
});
