import { gzipSync } from "node:zlib";

/**
 * Concatenate all tile bitmasks into a single gzip-compressed base64 string.
 *
 * Layout (before gzip):
 *   [outdoorMask: maskBytes]
 *   [frame0_sunMask: maskBytes]
 *   [frame0_sunMaskNoVeg: maskBytes]
 *   [frame1_sunMask: maskBytes]
 *   [frame1_sunMaskNoVeg: maskBytes]
 *   ...
 *
 * The client can slice the decompressed buffer deterministically using
 * maskBytes (= ceil(gridWidth * gridHeight / 8)) and frameCount.
 */
export function encodeTileMasksBlob(
  outdoorMask: Uint8Array,
  frameMasks: Array<{ sun: Uint8Array; sunNoVeg: Uint8Array }>,
): string {
  const maskBytes = outdoorMask.length;
  const totalBytes = maskBytes * (1 + frameMasks.length * 2);
  const buffer = new Uint8Array(totalBytes);

  let offset = 0;
  buffer.set(outdoorMask, offset);
  offset += maskBytes;

  for (const frame of frameMasks) {
    buffer.set(frame.sun, offset);
    offset += maskBytes;
    buffer.set(frame.sunNoVeg, offset);
    offset += maskBytes;
  }

  const compressed = gzipSync(buffer, { level: 6 });
  return Buffer.from(compressed).toString("base64");
}
