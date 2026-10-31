import sharp from 'sharp';

/**
 * 64-bit difference hash (dHash): shrink to 9×8 greyscale and record, for each row, whether each pixel
 * is brighter than its right neighbour. Survives resizing, recompression and small edits, so two shots
 * of the same scene land within a few bits of each other.
 */
export async function differenceHash(image: Buffer): Promise<bigint> {
  const pixels = await sharp(image).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();

  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = pixels[y * 9 + x]!;
      const right = pixels[y * 9 + x + 1]!;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash;
}

/** Postgres BIGINT is signed, so the unsigned 64-bit hash is stored in two's complement. */
export const toSignedInt64 = (hash: bigint): bigint => BigInt.asIntN(64, hash);

export function hammingDistance(a: bigint, b: bigint): number {
  let diff = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (diff) {
    diff &= diff - 1n;
    count++;
  }
  return count;
}
