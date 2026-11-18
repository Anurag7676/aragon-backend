import sharp from 'sharp';
import { pipelineRules, type VariantKind } from '../config/pipeline.js';

export interface GeneratedVariant {
  kind: VariantKind;
  data: Buffer;
  width: number;
  height: number;
  format: 'jpeg';
  contentType: 'image/jpeg';
}

/**
 * Builds every size from the compressed master:
 *  - full: the master itself (already compressed, so it isn't encoded a second time);
 *  - web: fits in 1280×1280, never enlarged;
 *  - thumbnail: 256×256 square cropped around the most interesting region (usually the face).
 */
export async function generateVariants(
  master: Buffer,
  quality: number = pipelineRules.compressionQuality,
): Promise<GeneratedVariant[]> {
  const metadata = await sharp(master).metadata();
  const encode = { quality, mozjpeg: true, progressive: true };

  const [web, thumbnail] = await Promise.all([
    sharp(master)
      .resize(pipelineRules.webMaxSide, pipelineRules.webMaxSide, { fit: 'inside', withoutEnlargement: true })
      .jpeg(encode)
      .toBuffer({ resolveWithObject: true }),
    sharp(master)
      .resize(pipelineRules.thumbnailSize, pipelineRules.thumbnailSize, {
        fit: 'cover',
        position: 'attention',
        withoutEnlargement: true,
      })
      .jpeg(encode)
      .toBuffer({ resolveWithObject: true }),
  ]);

  const jpeg = { format: 'jpeg', contentType: 'image/jpeg' } as const;
  return [
    { kind: 'thumbnail', data: thumbnail.data, width: thumbnail.info.width, height: thumbnail.info.height, ...jpeg },
    { kind: 'web', data: web.data, width: web.info.width, height: web.info.height, ...jpeg },
    { kind: 'full', data: master, width: metadata.width, height: metadata.height, ...jpeg },
  ];
}
