import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../sequelize.js';

/**
 * One row per issued refresh token. Tokens rotate on every use; all tokens from one login share a
 * familyId so that reuse of an old token can revoke the whole session.
 */
export class RefreshToken extends Model<InferAttributes<RefreshToken>, InferCreationAttributes<RefreshToken>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare familyId: string;
  /** SHA-256 of the token; the token itself only lives in the httpOnly cookie. */
  declare tokenHash: string;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare replacedById: string | null;
  declare userAgent: string | null;
  declare ipAddress: string | null;
  declare createdAt: CreationOptional<Date>;
}

RefreshToken.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    familyId: { type: DataTypes.UUID, allowNull: false },
    tokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    replacedById: { type: DataTypes.UUID, allowNull: true },
    userAgent: { type: DataTypes.STRING(255), allowNull: true },
    ipAddress: { type: DataTypes.STRING(64), allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'refresh_tokens', updatedAt: false },
);
