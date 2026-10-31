import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../sequelize.js';

/**
 * pending_upload → queued → processing → accepted | rejected
 *                                      ↘ failed (processing error after retries)
 */
export const IMAGE_STATUSES = ['pending_upload', 'queued', 'processing', 'accepted', 'rejected', 'failed'] as const;
export type ImageStatus = (typeof IMAGE_STATUSES)[number];

export const IMAGE_FORMATS = ['jpeg', 'png', 'heic'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export class Image extends Model<InferAttributes<Image>, InferCreationAttributes<Image>> {
  declare id: CreationOptional<string>;
  declare userId: string;
  declare originalName: string;
  /** Content type the client declared; the real format is detected from the bytes. */
  declare contentType: string;
  declare sizeBytes: number;
  declare format: ImageFormat | null;
  declare width: number | null;
  declare height: number | null;
  declare status: ImageStatus;
  declare rejectionReasons: CreationOptional<string[]>;
  declare originalKey: string;
  declare displayKey: string | null;
  declare thumbnailKey: string | null;
  /** 64-bit difference hash stored as a signed BIGINT (Sequelize returns BIGINT as a string). */
  declare perceptualHash: string | null;
  declare sharpness: number | null;
  declare faceCount: number | null;
  declare faceSizeRatio: number | null;
  declare failureReason: string | null;
  declare processedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Image.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    originalName: { type: DataTypes.STRING(255), allowNull: false },
    contentType: { type: DataTypes.STRING(64), allowNull: false },
    sizeBytes: { type: DataTypes.INTEGER, allowNull: false },
    format: { type: DataTypes.ENUM(...IMAGE_FORMATS), allowNull: true },
    width: { type: DataTypes.INTEGER, allowNull: true },
    height: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.ENUM(...IMAGE_STATUSES), allowNull: false, defaultValue: 'pending_upload' },
    rejectionReasons: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    originalKey: { type: DataTypes.STRING(512), allowNull: false },
    displayKey: { type: DataTypes.STRING(512), allowNull: true },
    thumbnailKey: { type: DataTypes.STRING(512), allowNull: true },
    perceptualHash: { type: DataTypes.BIGINT, allowNull: true },
    sharpness: { type: DataTypes.REAL, allowNull: true },
    faceCount: { type: DataTypes.INTEGER, allowNull: true },
    faceSizeRatio: { type: DataTypes.REAL, allowNull: true },
    failureReason: { type: DataTypes.STRING(500), allowNull: true },
    processedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'images' },
);
