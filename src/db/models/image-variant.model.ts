import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { VARIANT_KINDS, type VariantKind } from '../../config/pipeline.js';
import { sequelize } from '../sequelize.js';

export class ImageVariant extends Model<InferAttributes<ImageVariant>, InferCreationAttributes<ImageVariant>> {
  declare id: CreationOptional<string>;
  declare imageId: string;
  declare kind: VariantKind;
  declare run: number;
  declare s3Key: string;
  declare url: string;
  declare width: number;
  declare height: number;
  declare bytes: number;
  declare format: string;
  declare contentType: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ImageVariant.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    imageId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.ENUM(...VARIANT_KINDS), allowNull: false },
    run: { type: DataTypes.INTEGER, allowNull: false },
    s3Key: { type: DataTypes.STRING(512), allowNull: false },
    url: { type: DataTypes.STRING(1024), allowNull: false },
    width: { type: DataTypes.INTEGER, allowNull: false },
    height: { type: DataTypes.INTEGER, allowNull: false },
    bytes: { type: DataTypes.INTEGER, allowNull: false },
    format: { type: DataTypes.STRING(16), allowNull: false },
    contentType: { type: DataTypes.STRING(64), allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'image_variants',
    indexes: [{ unique: true, fields: ['image_id', 'kind'], name: 'image_variants_image_kind_key' }],
  },
);
