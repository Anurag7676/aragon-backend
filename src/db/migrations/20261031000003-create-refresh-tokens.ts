import { DataTypes, Sequelize } from 'sequelize';
import type { Migration } from '../umzug.js';

export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.createTable('refresh_tokens', {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: Sequelize.literal('gen_random_uuid()') },
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
    },
    family_id: { type: DataTypes.UUID, allowNull: false },
    token_hash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    replaced_by_id: { type: DataTypes.UUID, allowNull: true },
    user_agent: { type: DataTypes.STRING(255), allowNull: true },
    ip_address: { type: DataTypes.STRING(64), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
  });
  await queryInterface.addIndex('refresh_tokens', ['user_id'], { name: 'refresh_tokens_user_idx' });
  await queryInterface.addIndex('refresh_tokens', ['family_id'], { name: 'refresh_tokens_family_idx' });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.dropTable('refresh_tokens');
};
