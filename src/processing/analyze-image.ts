import { validationRules, type ValidationRules } from '../config/rules.js';
import type { ImageFormat } from '../db/models/index.js';
import type { RejectionCode } from '../modules/images/rejection-reasons.js';
import { decodeImage, detectFormat, UnreadableImageError } from './decode.js';
import { detectFaces, type FaceBox } from './face-detector.js';
import { differenceHash } from './perceptual-hash.js';
import { measureSharpness, type Region } from './sharpness.js';

const DISPLAY_MAX_SIDE = 2048;
const THUMBNAIL = { width: 480, height: 600 };

export interface ImageAnalysis {
  format: ImageFormat | null;
  width: number | null;
  height: number | null;
  /** Every rule the photo fails, except similarity, which needs the user's other photos. */
  reasons: RejectionCode[];
  /** Upright JPEG with metadata (EXIF, GPS) removed; also the input for all checks below. */
  display?: Buffer;
  thumbnail?: Buffer;
  perceptualHash?: bigint;
  sharpness?: number;
  faceCount?: number;
  faceSizeRatio?: number;
}

/**
 * Runs every content check on one photo. Pure with respect to storage and the database, so it can be
 * unit-tested with plain buffers.
 */
export async function analyzeImage(
  buffer: Buffer,
  sizeBytes: number,
  rules: ValidationRules = validationRules,
): Promise<ImageAnalysis> {
  const format = await detectFormat(buffer);
  if (!format) return { format: null, width: null, height: null, reasons: ['UNSUPPORTED_FORMAT'] };

  let decoded;
  try {
    decoded = await decodeImage(buffer, format, rules.maxInputPixels);
  } catch (error) {
    if (error instanceof UnreadableImageError) return { format, width: null, height: null, reasons: ['UNREADABLE_FILE'] };
    throw error;
  }

  const { pipeline, width, height } = decoded;
  const reasons: RejectionCode[] = [];
  if (sizeBytes < rules.minFileBytes) reasons.push('FILE_TOO_SMALL');
  if (Math.min(width, height) < rules.minShortSidePx) reasons.push('RESOLUTION_TOO_LOW');

  // sharp drops EXIF/GPS metadata unless asked to keep it. Decoding above only read the header, so a
  // damaged pixel stream (e.g. a truncated JPEG) first fails here; that is the file's fault, not a
  // transient error worth retrying.
  let display: { data: Buffer; info: { width: number; height: number } };
  let thumbnail: Buffer;
  try {
    [display, thumbnail] = await Promise.all([
      pipeline
        .clone()
        .resize(DISPLAY_MAX_SIDE, DISPLAY_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer({ resolveWithObject: true }),
      pipeline
        .clone()
        .resize(THUMBNAIL.width, THUMBNAIL.height, { fit: 'cover', position: 'attention' })
        .webp({ quality: 80 })
        .toBuffer(),
    ]);
  } catch {
    return { format, width, height, reasons: ['UNREADABLE_FILE'] };
  }
  const displayWidth = display.info.width;
  const displayHeight = display.info.height;

  const faces = (await detectFaces(display.data)).filter((face) => face.score >= rules.faceMinConfidence);
  const face = evaluateFaces(faces, displayWidth, displayHeight, rules);
  reasons.push(...face.reasons);

  const [sharpness, perceptualHash] = await Promise.all([
    measureSharpness(display.data, face.primary ? faceRegion(face.primary, displayWidth, displayHeight) : undefined),
    differenceHash(display.data),
  ]);
  if (sharpness < rules.minSharpness) reasons.push('BLURRY');

  return {
    format,
    width,
    height,
    reasons,
    display: display.data,
    thumbnail,
    perceptualHash,
    sharpness,
    faceCount: face.count,
    faceSizeRatio: face.sizeRatio,
  };
}

interface FaceEvaluation {
  primary: FaceBox | undefined;
  count: number;
  sizeRatio: number;
  reasons: RejectionCode[];
}

export function evaluateFaces(faces: FaceBox[], width: number, height: number, rules: ValidationRules): FaceEvaluation {
  const primary = faces.reduce<FaceBox | undefined>(
    (largest, face) => (!largest || face.width * face.height > largest.width * largest.height ? face : largest),
    undefined,
  );
  if (!primary) return { primary, count: 0, sizeRatio: 0, reasons: ['NO_FACE'] };

  // Small faces far in the background (a poster, a passer-by) don't count as a second person.
  const primarySide = Math.max(primary.width, primary.height);
  const count = faces.filter(
    (face) => Math.max(face.width, face.height) >= primarySide * rules.secondaryFaceMinRelativeSize,
  ).length;
  const sizeRatio = primarySide / Math.min(width, height);

  const reasons: RejectionCode[] = [];
  if (count > 1) reasons.push('MULTIPLE_FACES');
  if (sizeRatio < rules.minFaceSizeRatio) reasons.push('FACE_TOO_SMALL');
  return { primary, count, sizeRatio, reasons };
}

/** Face box clamped to the image, with whole-pixel coordinates for sharp.extract(). */
function faceRegion(face: FaceBox, width: number, height: number): Region {
  const left = Math.max(0, Math.floor(face.x));
  const top = Math.max(0, Math.floor(face.y));
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.ceil(face.width))),
    height: Math.max(1, Math.min(height - top, Math.ceil(face.height))),
  };
}
