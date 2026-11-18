import { pipelineRules } from '../config/pipeline.js';
import { validationRules } from '../config/rules.js';
import type { ImageFormat } from '../db/models/index.js';
import { decodeImage, detectFormat, UnreadableImageError, UnsupportedFormatError } from './decode.js';

export interface ConvertedImage {
  data: Buffer;
  width: number;
  height: number;
  sourceFormat: ImageFormat;
}

/**
 * Turns any accepted input (JPEG, PNG, HEIC) into one consistent master: an upright, 8-bit sRGB JPEG
 * with no metadata. Transparency is filled with white because JPEG has no alpha channel.
 * The quality is high on purpose; the compression stage decides the final size.
 */
export async function convertImage(buffer: Buffer, maxPixels: number = validationRules.maxInputPixels): Promise<ConvertedImage> {
  const sourceFormat = await detectFormat(buffer);
  if (!sourceFormat) throw new UnsupportedFormatError();

  const { pipeline } = await decodeImage(buffer, sourceFormat, maxPixels);
  try {
    const { data, info } = await pipeline
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: pipelineRules.conversionQuality, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, sourceFormat };
  } catch (error) {
    // The header decoded but the pixel data didn't (e.g. a truncated file).
    throw new UnreadableImageError('Could not decode the image data', { cause: error });
  }
}
