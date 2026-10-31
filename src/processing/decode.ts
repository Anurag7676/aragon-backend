import { fileTypeFromBuffer } from 'file-type';
import heicDecode from 'heic-decode';
import sharp, { type Sharp } from 'sharp';
import type { ImageFormat } from '../db/models/index.js';

const FORMAT_BY_MIME: Record<string, ImageFormat> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
};

/** Thrown when an image of an accepted format can't be decoded safely (corrupt, or too many pixels). */
export class UnreadableImageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnreadableImageError';
  }
}

/** Detects the real format from the file's magic bytes, ignoring its name and declared type. */
export async function detectFormat(buffer: Buffer): Promise<ImageFormat | null> {
  const type = await fileTypeFromBuffer(buffer);
  return type ? (FORMAT_BY_MIME[type.mime] ?? null) : null;
}

export interface DecodedImage {
  /** Upright pipeline (EXIF orientation applied); clone() it for each output. */
  pipeline: Sharp;
  width: number;
  height: number;
}

/**
 * Decodes JPEG/PNG with sharp and HEIC with libheif (sharp's prebuilt binaries can't read HEVC).
 * The pixel limit is checked before any full decode to block decompression bombs.
 */
export async function decodeImage(buffer: Buffer, format: ImageFormat, maxPixels: number): Promise<DecodedImage> {
  try {
    if (format === 'heic') return await decodeHeic(buffer, maxPixels);

    const pipeline = sharp(buffer, { limitInputPixels: maxPixels, failOn: 'error' }).rotate();
    const { autoOrient } = await pipeline.metadata();
    return { pipeline, width: autoOrient.width, height: autoOrient.height };
  } catch (error) {
    if (error instanceof UnreadableImageError) throw error;
    throw new UnreadableImageError('Could not decode image', { cause: error });
  }
}

async function decodeHeic(buffer: Buffer, maxPixels: number): Promise<DecodedImage> {
  const images = await heicDecode.all({ buffer });
  try {
    // The first image is the primary one; Live Photos and bursts carry extra frames.
    const primary = images[0];
    if (!primary) throw new UnreadableImageError('HEIC file has no image');
    if (primary.width * primary.height > maxPixels) throw new UnreadableImageError('HEIC image has too many pixels');

    // libheif applies the file's rotation/mirror transforms while decoding, so the result is upright.
    const { width, height, data } = await primary.decode();
    const pixels = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return { pipeline: sharp(pixels, { raw: { width, height, channels: 4 } }), width, height };
  } finally {
    images.dispose();
  }
}
