import { DataTypes, Sequelize } from 'sequelize';
import type { Migration } from '../umzug.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('images', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    original_name: { type: DataTypes.STRING(255), allowNull: false },
    content_type: { type: DataTypes.STRING(64), allowNull: false },
    size_bytes: { type: DataTypes.INTEGER, allowNull: false },
    format: { type: DataTypes.ENUM('jpeg', 'png', 'heic'), allowNull: true },
    width: { type: DataTypes.INTEGER, allowNull: true },
    height: { type: DataTypes.INTEGER, allowNull: true },
    status: {
      type: DataTypes.ENUM('pending_upload', 'queued', 'processing', 'accepted', 'rejected', 'failed'),
      allowNull: false,
      defaultValue: 'pending_upload',
    },
    rejection_reasons: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    original_key: { type: DataTypes.STRING(512), allowNull: false },
    display_key: { type: DataTypes.STRING(512), allowNull: true },
    thumbnail_key: { type: DataTypes.STRING(512), allowNull: true },
    perceptual_hash: { type: DataTypes.BIGINT, allowNull: true },
    sharpness: { type: DataTypes.REAL, allowNull: true },
    face_count: { type: DataTypes.INTEGER, allowNull: true },
    face_size_ratio: { type: DataTypes.REAL, allowNull: true },
    failure_reason: { type: DataTypes.STRING(500), allowNull: true },
    processed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  // Listing a user's photos by status, newest first, with keyset pagination on (created_at, id).
  await queryInterface.sequelize.query(
    'CREATE INDEX images_user_status_created_idx ON images (user_id, status, created_at DESC, id DESC)',
  );
  // Near-duplicate check: scans only the user's accepted hashes, answered from the index alone.
  await queryInterface.sequelize.query(
    `CREATE INDEX images_user_accepted_hash_idx ON images (user_id) INCLUDE (perceptual_hash)
     WHERE status = 'accepted' AND perceptual_hash IS NOT NULL`,
  );
  // Maintenance sweep for abandoned uploads and stuck queue entries.
  await queryInterface.sequelize.query(
    `CREATE INDEX images_unfinished_idx ON images (status, updated_at)
     WHERE status IN ('pending_upload', 'queued')`,
  );
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('images');
  await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_images_status"');
  await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_images_format"');
};
