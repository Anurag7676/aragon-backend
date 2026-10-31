import { DataTypes, Sequelize } from 'sequelize';
import type { Migration } from '../umzug.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('email_otps', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    purpose: { type: DataTypes.ENUM('verify_email', 'reset_password'), allowNull: false },
    code_hash: { type: DataTypes.STRING(64), allowNull: false },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    consumed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  });
  // Lookup of the latest code for a user and purpose.
  await queryInterface.addIndex('email_otps', ['user_id', 'purpose', 'created_at'], {
    name: 'email_otps_user_purpose_created_idx',
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('email_otps');
  await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_email_otps_purpose"');
};
