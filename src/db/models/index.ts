import { EmailOtp } from './email-otp.model.js';
import { Image } from './image.model.js';
import { RefreshToken } from './refresh-token.model.js';
import { User } from './user.model.js';

User.hasMany(Image, { foreignKey: 'userId', as: 'images' });
Image.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(EmailOtp, { foreignKey: 'userId', as: 'otps' });
EmailOtp.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(RefreshToken, { foreignKey: 'userId', as: 'refreshTokens' });
RefreshToken.belongsTo(User, { foreignKey: 'userId', as: 'user' });

export { EmailOtp, Image, RefreshToken, User };
export { OTP_PURPOSES, type OtpPurpose } from './email-otp.model.js';
export { IMAGE_FORMATS, IMAGE_STATUSES, type ImageFormat, type ImageStatus } from './image.model.js';
