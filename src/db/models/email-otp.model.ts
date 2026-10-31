import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../sequelize.js';

export const OTP_PURPOSES = ['verify_email', 'reset_password'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export class EmailOtp extends Model<InferAttributes<EmailOtp>, InferCreationAttributes<EmailOtp>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare purpose: OtpPurpose;
  /** HMAC of the code; the code itself is never stored. */
  declare codeHash: string;
  declare expiresAt: Date;
  declare attempts: CreationOptional<number>;
  declare consumedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
}

EmailOtp.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    purpose: { type: DataTypes.ENUM(...OTP_PURPOSES), allowNull: false },
    codeHash: { type: DataTypes.STRING(64), allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    consumedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'email_otps', updatedAt: false },
);
