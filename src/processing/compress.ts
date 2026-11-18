import sharp from 'sharp';
import { pipelineRules } from '../config/pipeline.js';

export interface CompressedImage {
  data: Buffer;
  inputBytes: number;
  outputBytes: number;
  /** inputBytes / outputBytes; 1 when re-encoding didn't help and the input was kept. */
  ratio: number;
  /** JPEG quality of the output, or null if the input was kept unchanged. */
  quality: number | null;
}

/**
 * Re-encodes the converted master with mozjpeg (trellis quantisation, optimised Huffman tables,
 * progressive scan), which keeps quality 80 visually close to the original at a fraction of the size.
 * If that ever produces a bigger file, the input is kept.
 */
export async function compressImage(buffer: Buffer, quality: number = pipelineRules.compressionQuality): Promise<CompressedImage> {
  const output = await sharp(buffer).jpeg({ quality, mozjpeg: true, progressive: true }).toBuffer();
  const keepInput = output.length >= buffer.length;
  const data = keepInput ? buffer : output;
  return {
    data,
    inputBytes: buffer.length,
    outputBytes: data.length,
    ratio: Math.round((buffer.length / data.length) * 100) / 100,
    quality: keepInput ? null : quality,
  };
}
