declare module 'heic-decode' {
  interface DecodedImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  interface LazyImage {
    width: number;
    height: number;
    decode(): Promise<DecodedImage>;
  }

  interface HeicDecode {
    (input: { buffer: ArrayBufferLike | Uint8Array }): Promise<DecodedImage>;
    all(input: { buffer: ArrayBufferLike | Uint8Array }): Promise<LazyImage[] & { dispose(): void }>;
  }

  const decode: HeicDecode;
  export default decode;
}
