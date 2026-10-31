import sharp from 'sharp';

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Large crops are scaled down to this size so scores are comparable across resolutions. Small crops are
 * never scaled up: interpolation smooths edges and would make a sharp small face look blurry.
 */
const ANALYSIS_SIZE = 256;

/**
 * Sharpness as the variance of the Laplacian: sharp edges give large second derivatives, so a blurry
 * image has a low variance. Measured on the face when there is one, since background blur (bokeh) is fine.
 */
export async function measureSharpness(image: Buffer, region?: Region): Promise<number> {
  let pipeline = sharp(image);
  if (region) pipeline = pipeline.extract(region);
  const { data, info } = await pipeline
    .greyscale()
    .resize(ANALYSIS_SIZE, ANALYSIS_SIZE, { fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return laplacianVariance(data, info.width, info.height);
}

/** 4-neighbour Laplacian over a single-channel image. */
export function laplacianVariance(pixels: Uint8Array, width: number, height: number): number {
  let sum = 0;
  let sumOfSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const value = 4 * pixels[i]! - pixels[i - 1]! - pixels[i + 1]! - pixels[i - width]! - pixels[i + width]!;
      sum += value;
      sumOfSquares += value * value;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumOfSquares / count - mean * mean;
}
