import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { pipelineRules } from '../../src/config/pipeline.js';
import { compressImage } from '../../src/processing/compress.js';
import { convertImage } from '../../src/processing/convert.js';
import { UnreadableImageError, UnsupportedFormatError } from '../../src/processing/decode.js';
import { generateVariants } from '../../src/processing/variants.js';
import { fixture } from '../helpers/factories.js';

const astronaut = fixture('astronaut.png');
const heic = fixture('example.heic');

describe('convertImage', () => {
  it('turns a HEIC into an upright sRGB JPEG', async () => {
    const converted = await convertImage(heic);
    const meta = await sharp(converted.data).metadata();

    expect(converted.sourceFormat).toBe('heic');
    expect(meta).toMatchObject({ format: 'jpeg', space: 'srgb', width: converted.width, height: converted.height });
    expect(meta.exif).toBeUndefined();
  });

  it('flattens transparency onto white', async () => {
    const transparent = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const converted = await convertImage(transparent);
    const { data, info } = await sharp(converted.data).raw().toBuffer({ resolveWithObject: true });

    expect(converted.sourceFormat).toBe('png');
    expect(info.channels).toBe(3);
    expect(data[0]).toBeGreaterThan(250); // white, not black
  });

  it('applies EXIF rotation and drops the metadata', async () => {
    const rotated = await sharp(astronaut)
      .resize(300, 200, { fit: 'fill' })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'someone' } } })
      .toBuffer();

    const converted = await convertImage(rotated);
    const meta = await sharp(converted.data).metadata();

    expect([converted.width, converted.height]).toEqual([200, 300]);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it('rejects files that are not images', async () => {
    await expect(convertImage(Buffer.from('definitely not a photo'))).rejects.toBeInstanceOf(UnsupportedFormatError);
  });

  it('rejects truncated images', async () => {
    const jpeg = await sharp(astronaut).jpeg().toBuffer();
    await expect(convertImage(jpeg.subarray(0, Math.floor(jpeg.length / 2)))).rejects.toBeInstanceOf(
      UnreadableImageError,
    );
  });

  it('refuses images over the pixel limit before decoding them', async () => {
    await expect(convertImage(astronaut, 100 * 100)).rejects.toBeInstanceOf(UnreadableImageError);
  });
});

describe('compressImage', () => {
  it('makes the converted master smaller and reports the ratio', async () => {
    const { data: master } = await convertImage(astronaut);
    const result = await compressImage(master);

    expect(result.outputBytes).toBeLessThan(result.inputBytes);
    expect(result.data.length).toBe(result.outputBytes);
    expect(result.ratio).toBeGreaterThan(1);
    expect(result.quality).toBe(pipelineRules.compressionQuality);
    expect((await sharp(result.data).metadata()).format).toBe('jpeg');
  });

  it('keeps the input when re-encoding would make it bigger', async () => {
    const tiny = await sharp(astronaut).resize(64).jpeg({ quality: 10, mozjpeg: true }).toBuffer();
    const result = await compressImage(tiny, 100);

    expect(result.data).toBe(tiny);
    expect(result).toMatchObject({ ratio: 1, quality: null, outputBytes: tiny.length });
  });
});

describe('generateVariants', () => {
  it('makes a thumbnail, a web size and a full size', async () => {
    const big = await sharp(astronaut).resize(2400, 1600, { fit: 'fill' }).jpeg({ quality: 80 }).toBuffer();
    const variants = await generateVariants(big);

    expect(variants.map((variant) => variant.kind)).toEqual(['thumbnail', 'web', 'full']);
    const [thumbnail, web, full] = variants;
    expect(thumbnail).toMatchObject({ width: 256, height: 256, contentType: 'image/jpeg' });
    expect(web).toMatchObject({ width: 1280, height: 853 });
    expect(full).toMatchObject({ width: 2400, height: 1600 });
    // The full size is the compressed master itself, not a second encode.
    expect(full!.data).toBe(big);
    for (const variant of variants) {
      expect(await sharp(variant.data).metadata()).toMatchObject({ width: variant.width, height: variant.height });
    }
  });

  it('never enlarges a photo smaller than the web size', async () => {
    const small = await sharp(astronaut).jpeg().toBuffer(); // 512×512
    const [, web, full] = await generateVariants(small);
    expect(web).toMatchObject({ width: 512, height: 512 });
    expect(full).toMatchObject({ width: 512, height: 512 });
  });
});
