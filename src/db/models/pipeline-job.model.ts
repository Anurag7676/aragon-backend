import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { PIPELINE_STAGES, type PipelineStage } from '../../config/pipeline.js';
import { sequelize } from '../sequelize.js';

/**
 * queued → converting → compressing → generating_variants → completed
 *    ↘──────────────↘──────────────↘────────────────────↘ failed (stage, code and message saved)
 *
 * Each status names the stage the job is waiting for or running; the *_started_at columns tell the two
 * apart.
 */
export const PIPELINE_STATUSES = [
  'queued',
  'converting',
  'compressing',
  'generating_variants',
  'completed',
  'failed',
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export class PipelineJob extends Model<InferAttributes<PipelineJob>, InferCreationAttributes<PipelineJob>> {
  declare id: CreationOptional<string>;
  declare imageId: string;
  /** Goes up by one on every reprocess; jobs from an older run are ignored. */
  declare run: CreationOptional<number>;
  declare status: CreationOptional<PipelineStatus>;
  declare failedStage: CreationOptional<PipelineStage | null>;
  declare errorCode: CreationOptional<string | null>;
  declare errorMessage: CreationOptional<string | null>;
  declare sourceFormat: CreationOptional<string | null>;
  declare width: CreationOptional<number | null>;
  declare height: CreationOptional<number | null>;
  declare originalBytes: CreationOptional<number | null>;
  declare convertedBytes: CreationOptional<number | null>;
  declare compressedBytes: CreationOptional<number | null>;
  declare compressionRatio: CreationOptional<number | null>;
  declare jpegQuality: CreationOptional<number | null>;
  declare queuedAt: Date;
  declare conversionStartedAt: CreationOptional<Date | null>;
  declare convertedAt: CreationOptional<Date | null>;
  declare compressionStartedAt: CreationOptional<Date | null>;
  declare compressedAt: CreationOptional<Date | null>;
  declare variantsStartedAt: CreationOptional<Date | null>;
  declare completedAt: CreationOptional<Date | null>;
  declare failedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

PipelineJob.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    imageId: { type: DataTypes.UUID, allowNull: false, unique: true },
    run: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    status: { type: DataTypes.ENUM(...PIPELINE_STATUSES), allowNull: false, defaultValue: 'queued' },
    failedStage: { type: DataTypes.ENUM(...PIPELINE_STAGES), allowNull: true, defaultValue: null },
    errorCode: { type: DataTypes.STRING(64), allowNull: true, defaultValue: null },
    errorMessage: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
    sourceFormat: { type: DataTypes.STRING(16), allowNull: true, defaultValue: null },
    width: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    height: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    originalBytes: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    convertedBytes: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    compressedBytes: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    compressionRatio: { type: DataTypes.REAL, allowNull: true, defaultValue: null },
    jpegQuality: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    queuedAt: { type: DataTypes.DATE, allowNull: false },
    conversionStartedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    convertedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    compressionStartedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    compressedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    variantsStartedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    completedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    failedAt: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  { sequelize, tableName: 'pipeline_jobs' },
);
