import { DataTypes, Sequelize } from 'sequelize';
import type { Migration } from '../umzug.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('pipeline_jobs', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
    // One job per image; a reprocess reuses the row with a higher run number.
    image_id: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
      references: { model: 'images', key: 'id' },
      onDelete: 'CASCADE',
    },
    run: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    status: {
      type: DataTypes.ENUM('queued', 'converting', 'compressing', 'generating_variants', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'queued',
    },
    failed_stage: { type: DataTypes.ENUM('conversion', 'compression', 'variants'), allowNull: true },
    error_code: { type: DataTypes.STRING(64), allowNull: true },
    error_message: { type: DataTypes.STRING(500), allowNull: true },
    source_format: { type: DataTypes.STRING(16), allowNull: true },
    width: { type: DataTypes.INTEGER, allowNull: true },
    height: { type: DataTypes.INTEGER, allowNull: true },
    original_bytes: { type: DataTypes.INTEGER, allowNull: true },
    converted_bytes: { type: DataTypes.INTEGER, allowNull: true },
    compressed_bytes: { type: DataTypes.INTEGER, allowNull: true },
    /** converted_bytes / compressed_bytes, e.g. 3.2 means the file got 3.2× smaller. */
    compression_ratio: { type: DataTypes.REAL, allowNull: true },
    jpeg_quality: { type: DataTypes.INTEGER, allowNull: true },
    queued_at: { type: DataTypes.DATE, allowNull: false },
    conversion_started_at: { type: DataTypes.DATE, allowNull: true },
    converted_at: { type: DataTypes.DATE, allowNull: true },
    compression_started_at: { type: DataTypes.DATE, allowNull: true },
    compressed_at: { type: DataTypes.DATE, allowNull: true },
    variants_started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    failed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  // Maintenance sweep: unfinished jobs that haven't moved for a while.
  await queryInterface.sequelize.query(
    `CREATE INDEX pipeline_jobs_unfinished_idx ON pipeline_jobs (updated_at)
     WHERE status NOT IN ('completed', 'failed')`,
  );
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('pipeline_jobs');
  await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_pipeline_jobs_status"');
  await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_pipeline_jobs_failed_stage"');
};
