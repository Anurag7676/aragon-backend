import { DataTypes, Sequelize } from 'sequelize';
import type { Migration } from '../umzug.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('image_variants', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
    image_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'images', key: 'id' },
      onDelete: 'CASCADE',
    },
    kind: { type: DataTypes.ENUM('thumbnail', 'web', 'full'), allowNull: false },
    /** The pipeline run that last wrote this variant. */
    run: { type: DataTypes.INTEGER, allowNull: false },
    s3_key: { type: DataTypes.STRING(512), allowNull: false },
    /** The object's S3 address. The bucket is private, so clients get a signed copy of it. */
    url: { type: DataTypes.STRING(1024), allowNull: false },
    width: { type: DataTypes.INTEGER, allowNull: false },
    height: { type: DataTypes.INTEGER, allowNull: false },
    bytes: { type: DataTypes.INTEGER, allowNull: false },
    format: { type: DataTypes.STRING(16), allowNull: false },
    content_type: { type: DataTypes.STRING(64), allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  // At most one row per image and size: reprocessing updates rows instead of adding new ones.
  await queryInterface.addConstraint('image_variants', {
    fields: ['image_id', 'kind'],
    type: 'unique',
    name: 'image_variants_image_kind_key',
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('image_variants');
  await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_image_variants_kind"');
};
