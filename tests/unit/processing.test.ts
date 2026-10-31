import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { validationRules } from '../../src/config/rules.js';
import { analyzeImage, evaluateFaces } from '../../src/processing/analyze-image.js';
import type { FaceBox } from '../../src/processing/face-detector.js';
import { differenceHash, hammingDistance, toSignedInt64 } from '../../src/processing/perceptual-hash.js';
import { laplacianVariance } from '../../src/processing/sharpness.js';
import { fixture } from '../helpers/factories.js';

const astronaut = fixture('astronaut.png');

/** Deterministic noise so the "unrelated image" never depends on Math.random. */
async function noiseImage(size = 256): Promise<Buffer> {
  const pixels = Buffer.alloc(size * size * 3);
  let seed = 42;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    pixels[i] = seed % 256;
  }
  return sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

const face = (x: number, y: number, size: number, score = 0.9): FaceBox => ({ x, y, width: size, height: size, score });

describe('laplacianVariance', () => {
  it('is zero for a flat image', () => {
    expect(laplacianVariance(new Uint8Array(100).fill(128), 10, 10)).toBe(0);
  });

  it('is high for hard edges', () => {
    const size = 16;
    const checkerboard = new Uint8Array(size * size).map((_, i) => ((i % size) + Math.floor(i / size)) % 2 ? 255 : 0);
    expect(laplacianVariance(checkerboard, size, size)).toBeGreaterThan(10_000);
  });

  it('is zero when the image is too small to have interior pixels', () => {
    expect(laplacianVariance(new Uint8Array([0, 255, 0, 255]), 2, 2)).toBe(0);
  });
});

describe('differenceHash', () => {
  it('gives identical hashes for the same image', async () => {
    expect(hammingDistance(await differenceHash(astronaut), await differenceHash(astronaut))).toBe(0);
  });

  it('stays close for a cropped, resized and recompressed copy', async () => {
    const copy = await sharp(astronaut)
      .extract({ left: 8, top: 8, width: 496, height: 496 })
      .resize(1000)
      .jpeg({ quality: 70 })
      .toBuffer();
    expect(hammingDistance(await differenceHash(astronaut), await differenceHash(copy))).toBeLessThanOrEqual(
      validationRules.maxSimilarityDistance,
    );
  });

  it('is far apart for unrelated images', async () => {
    const distance = hammingDistance(await differenceHash(astronaut), await differenceHash(await noiseImage()));
    expect(distance).toBeGreaterThan(validationRules.maxSimilarityDistance);
  });
});

describe('hammingDistance and toSignedInt64', () => {
  it('counts differing bits', () => {
    expect(hammingDistance(0b1011n, 0b0001n)).toBe(2);
    expect(hammingDistance(0n, 0xffff_ffff_ffff_ffffn)).toBe(64);
  });

  it('round-trips an unsigned 64-bit hash through Postgres BIGINT range', () => {
    const unsigned = 0xf0f0_0000_0000_0001n;
    const signed = toSignedInt64(unsigned);
    expect(signed).toBeLessThan(0n);
    expect(signed).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(BigInt.asUintN(64, signed)).toBe(unsigned);
    expect(hammingDistance(signed, unsigned)).toBe(0);
  });
});

describe('evaluateFaces', () => {
  it('rejects a photo with no face', () => {
    expect(evaluateFaces([], 1000, 1000, validationRules)).toMatchObject({ count: 0, reasons: ['NO_FACE'] });
  });

  it('rejects a face that is too small in the frame', () => {
    const result = evaluateFaces([face(100, 100, 50)], 1000, 1000, validationRules);
    expect(result.reasons).toEqual(['FACE_TOO_SMALL']);
    expect(result.sizeRatio).toBeCloseTo(0.05);
  });

  it('accepts one large face', () => {
    expect(evaluateFaces([face(300, 200, 400)], 1000, 1000, validationRules)).toMatchObject({
      count: 1,
      reasons: [],
    });
  });

  it('ignores a tiny face in the background', () => {
    const result = evaluateFaces([face(300, 200, 400), face(900, 50, 50)], 1000, 1000, validationRules);
    expect(result.count).toBe(1);
    expect(result.reasons).toEqual([]);
  });

  it('rejects two people of similar size', () => {
    const result = evaluateFaces([face(100, 200, 350), face(550, 200, 300)], 1000, 1000, validationRules);
    expect(result.count).toBe(2);
    expect(result.reasons).toContain('MULTIPLE_FACES');
  });

  it('measures face size against the shorter side of the photo', () => {
    // A 300 px face in a 3000×1000 landscape is 30% of the short side.
    expect(evaluateFaces([face(0, 0, 300)], 3000, 1000, validationRules).sizeRatio).toBeCloseTo(0.3);
  });
});

describe('analyzeImage', () => {
  let accepted: Awaited<ReturnType<typeof analyzeImage>>;

  beforeAll(async () => {
    accepted = await analyzeImage(astronaut, astronaut.length);
  });

  it('accepts a sharp, single-face portrait', () => {
    expect(accepted.reasons).toEqual([]);
    expect(accepted).toMatchObject({ format: 'png', width: 512, height: 512, faceCount: 1 });
    expect(accepted.sharpness).toBeGreaterThan(validationRules.minSharpness);
    expect(accepted.perceptualHash).toBeTypeOf('bigint');
  });

  it('produces a JPEG display image and a WebP thumbnail without metadata', async () => {
    const display = await sharp(accepted.display!).metadata();
    const thumbnail = await sharp(accepted.thumbnail!).metadata();
    expect(display.format).toBe('jpeg');
    expect(display.exif).toBeUndefined();
    expect(thumbnail).toMatchObject({ format: 'webp', width: 480, height: 600 });
  });

  it('rejects a blurred copy', async () => {
    const blurred = await sharp(astronaut).blur(4).jpeg({ quality: 92 }).toBuffer();
    const result = await analyzeImage(blurred, blurred.length);
    expect(result.reasons).toContain('BLURRY');
  });

  it('rejects a low-resolution copy', async () => {
    const small = await sharp(astronaut).resize(300).jpeg({ quality: 90 }).toBuffer();
    const result = await analyzeImage(small, 100_000);
    expect(result.reasons).toContain('RESOLUTION_TOO_LOW');
    expect(result.width).toBe(300);
  });

  it('rejects a file that is too small in bytes', async () => {
    const result = await analyzeImage(astronaut, 1_000);
    expect(result.reasons).toContain('FILE_TOO_SMALL');
  });

  it('decodes HEIC', async () => {
    const heic = fixture('example.heic');
    const result = await analyzeImage(heic, heic.length);
    expect(result).toMatchObject({ format: 'heic', width: 1280, height: 854 });
    expect(result.display).toBeInstanceOf(Buffer);
    // The libheif sample is a landscape with nobody in it.
    expect(result.reasons).toContain('NO_FACE');
  });

  it('rejects bytes that are not an image, whatever the file is called', async () => {
    const fake = Buffer.from('MZ\x90\x00 this is an executable renamed to photo.jpg');
    expect(await analyzeImage(fake, fake.length)).toEqual({
      format: null,
      width: null,
      height: null,
      reasons: ['UNSUPPORTED_FORMAT'],
    });
  });

  it('rejects other real image formats', async () => {
    const gif = await sharp(astronaut).gif().toBuffer();
    expect((await analyzeImage(gif, gif.length)).reasons).toEqual(['UNSUPPORTED_FORMAT']);
  });

  it('reports a truncated JPEG as unreadable instead of throwing', async () => {
    const jpeg = await sharp(astronaut).jpeg().toBuffer();
    const truncated = jpeg.subarray(0, Math.floor(jpeg.length / 2));
    expect((await analyzeImage(truncated, truncated.length)).reasons).toEqual(['UNREADABLE_FILE']);
  });

  it('reports an image over the pixel limit as unreadable', async () => {
    const huge = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#888' } })
      .png()
      .toBuffer();
    const result = await analyzeImage(huge, huge.length, { ...validationRules, maxInputPixels: 10_000 });
    expect(result.reasons).toEqual(['UNREADABLE_FILE']);
  });
});
