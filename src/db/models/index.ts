import { EmailOtp } from './email-otp.model.js';
import { ImageVariant } from './image-variant.model.js';
import { Image } from './image.model.js';
import { PipelineJob } from './pipeline-job.model.js';
import { RefreshToken } from './refresh-token.model.js';
import { User } from './user.model.js';

User.hasMany(Image, { foreignKey: 'userId', as: 'images' });
Image.belongsTo(User, { foreignKey: 'userId', as: 'user' });

Image.hasOne(PipelineJob, { foreignKey: 'imageId', as: 'pipeline' });
PipelineJob.belongsTo(Image, { foreignKey: 'imageId', as: 'image' });

Image.hasMany(ImageVariant, { foreignKey: 'imageId', as: 'variants' });
ImageVariant.belongsTo(Image, { foreignKey: 'imageId', as: 'image' });

User.hasMany(EmailOtp, { foreignKey: 'userId', as: 'otps' });
EmailOtp.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens' });
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });

export { EmailOtp, Image, ImageVariant, PipelineJob, RefreshToken, User };
export { OTP_PURPOSES, type OtpPurpose } from './email-otp.model.js';
export { IMAGE_FORMATS, IMAGE_STATUSES, type ImageFormat, type ImageStatus } from './image.model.js';
export { PIPELINE_STATUSES, type PipelineStatus } from './pipeline-job.model.js';
