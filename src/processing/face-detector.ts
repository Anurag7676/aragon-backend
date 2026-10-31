import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

/**
 * Face detection with OpenCV's YuNet model (MIT licence, 230 KB), run locally with ONNX Runtime.
 * No photo leaves the server. Decoding follows OpenCV's FaceDetectorYN implementation.
 */

const MODEL_PATH = fileURLToPath(new URL('../../models/face_detection_yunet_2023mar.onnx', import.meta.url));
const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32] as const;

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

export interface DetectionOptions {
  minScore?: number;
  nmsThreshold?: number;
}

let session: Promise<ort.InferenceSession> | undefined;
const getSession = () => (session ??= ort.InferenceSession.create(MODEL_PATH, { graphOptimizationLevel: 'all' }));

/** Loads the model ahead of the first job. */
export async function warmUpFaceDetector(): Promise<void> {
  await getSession();
}

/** Returns faces in the image's own pixel coordinates, highest score first. */
export async function detectFaces(image: Buffer, options: DetectionOptions = {}): Promise<FaceBox[]> {
  const { minScore = 0.6, nmsThreshold = 0.3 } = options;

  // Letterbox into the model's fixed 640×640 input, anchored top-left so coordinates only need scaling.
  const { data, info } = await sharp(image)
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'contain', position: 'left top', background: { r: 0, g: 0, b: 0 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const metadata = await sharp(image).metadata();
  const scale = INPUT_SIZE / Math.max(metadata.width, metadata.height);

  const outputs = await (await getSession()).run({ input: toBgrTensor(data, info.width, info.height) });

  const candidates: FaceBox[] = [];
  for (const stride of STRIDES) {
    const cls = outputs[`cls_${stride}`]!.data as Float32Array;
    const obj = outputs[`obj_${stride}`]!.data as Float32Array;
    const bbox = outputs[`bbox_${stride}`]!.data as Float32Array;
    const cols = INPUT_SIZE / stride;

    for (let index = 0; index < cls.length; index++) {
      const score = Math.sqrt(clamp01(cls[index]!) * clamp01(obj[index]!));
      if (score < minScore) continue;

      const row = Math.floor(index / cols);
      const col = index % cols;
      const centerX = (col + bbox[index * 4]!) * stride;
      const centerY = (row + bbox[index * 4 + 1]!) * stride;
      const width = Math.exp(bbox[index * 4 + 2]!) * stride;
      const height = Math.exp(bbox[index * 4 + 3]!) * stride;

      candidates.push({
        x: (centerX - width / 2) / scale,
        y: (centerY - height / 2) / scale,
        width: width / scale,
        height: height / scale,
        score,
      });
    }
  }

  return nonMaxSuppression(candidates, nmsThreshold);
}

/** HWC RGB bytes → NCHW float32 in BGR order with raw 0–255 values, as the model was trained. */
function toBgrTensor(rgb: Buffer, width: number, height: number): ort.Tensor {
  const plane = width * height;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    tensor[i] = rgb[i * 3 + 2]!;
    tensor[plane + i] = rgb[i * 3 + 1]!;
    tensor[2 * plane + i] = rgb[i * 3]!;
  }
  return new ort.Tensor('float32', tensor, [1, 3, height, width]);
}

function nonMaxSuppression(boxes: FaceBox[], threshold: number): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const kept: FaceBox[] = [];
  for (const box of sorted) {
    if (kept.every((other) => intersectionOverUnion(box, other) <= threshold)) kept.push(box);
  }
  return kept;
}

function intersectionOverUnion(a: FaceBox, b: FaceBox): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
