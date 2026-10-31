import { fileURLToPath, pathToFileURL } from 'node:url';
import type { QueryInterface } from 'sequelize';
import { SequelizeStorage, Umzug, type MigrationFn } from 'umzug';
import { logger } from '../lib/logger.js';
import { sequelize } from './sequelize.js';

export type Migration = MigrationFn<QueryInterface>;

interface MigrationModule {
  up: Migration;
  down: Migration;
}

// Works from src/ (tsx, .ts files) and from dist/ (compiled .js files).
const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

export const migrator = new Umzug<QueryInterface>({
  migrations: {
    glob: [`${migrationsDir}/*.{js,ts}`, { ignore: ['**/*.d.ts'] }],
    resolve: ({ name, path, context }) => {
      const load = async (): Promise<MigrationModule> => import(pathToFileURL(path!).href);
      return {
        // Strip the extension so a migration has the same name in src and dist.
        name: name.replace(/\.(js|ts)$/, ''),
        up: async () => (await load()).up({ name, path, context }),
        down: async () => (await load()).down({ name, path, context }),
      };
    },
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: 'schema_migrations' }),
  logger: {
    info: (message) => logger.info(message, 'migration'),
    warn: (message) => logger.warn(message, 'migration'),
    error: (message) => logger.error(message, 'migration'),
    debug: (message) => logger.debug(message, 'migration'),
  },
});
