/**
 * Deletes every load-test account, its photos' files in S3 and (by cascade) its database rows.
 *
 *   node dist/load-test/cleanup.js
 */
import { Op } from 'sequelize';
import { Image, User } from '../db/models/index.js';
import { sequelize } from '../db/sequelize.js';
import { closeQueues } from '../integrations/queue.js';
import { redis } from '../integrations/redis.js';
import { pipelineKeys, storage } from '../integrations/s3.js';
import { logger } from '../lib/logger.js';
import { LOAD_TEST_EMAIL_PATTERN } from './load-test-users.js';

try {
  const users = await User.findAll({ where: { email: { [Op.like]: LOAD_TEST_EMAIL_PATTERN } }, attributes: ['id'] });
  const userIds = users.map((user) => user.id);
  const images = await Image.findAll({
    where: { userId: userIds },
    attributes: ['id', 'userId', 'originalKey', 'displayKey', 'thumbnailKey'],
  });

  const keys = images.flatMap((image) =>
    [image.originalKey, image.displayKey, image.thumbnailKey, ...pipelineKeys(image.userId, image.id)].filter(
      (key) => key !== null,
    ),
  );
  await storage.deleteMany(keys);
  const deleted = await User.destroy({ where: { id: userIds } });
  logger.info({ users: deleted, images: images.length, files: keys.length }, 'load-test data removed');
} finally {
  await closeQueues();
  await sequelize.close();
  await redis.quit();
}
