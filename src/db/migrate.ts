import { logger } from '../lib/logger.js';
import { sequelize } from './sequelize.js';
import { migrator } from './umzug.js';

const command = process.argv[2] ?? 'up';

try {
  switch (command) {
    case 'up':
      await migrator.up();
      break;
    case 'down':
      await migrator.down();
      break;
    case 'status': {
      const executed = await migrator.executed();
      const pending = await migrator.pending();
      logger.info({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) }, 'migration status');
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use up, down or status.`);
  }
} catch (error) {
  logger.error({ err: error }, 'migration failed');
  process.exitCode = 1;
} finally {
  await sequelize.close();
}
