/**
 * Decode a gzip-compressed, base64-encoded tile masks blob.
 * Uses the browser-native DecompressionStream (C++ speed, no JS library).
 *
 * Returns the individual masks sliced from the decompressed buffer.
 */
export async function decodeTileMasksBlob(
  masksBase64: string,
  maskBytes: number,
  frameCount: number,
): Promise<{ outdoor: Uint8Array; frames: Array<{ sun: Uint8Array; sunNoVeg: Uint8Array }> }> {
  // Base64 → binary
  const binaryStr = atob(masksBase64);
  const compressed = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    compressed[i] = binaryStr.charCodeAt(i);
  }

  // Decompress via native DecompressionStream
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  // Write compressed data and close
  writer.write(compressed);
  writer.close();

  // Read all decompressed chunks
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLen += value.length;
  }

  // Merge chunks into a single buffer
  const decompressed = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    decompressed.set(chunk, offset);
    offset += chunk.length;
  }

  // Slice into individual masks
  offset = 0;
  const outdoor = decompressed.slice(offset, offset + maskBytes);
  offset += maskBytes;

  const frames: Array<{ sun: Uint8Array; sunNoVeg: Uint8Array }> = [];
  for (let i = 0; i < frameCount; i++) {
    const sun = decompressed.slice(offset, offset + maskBytes);
    offset += maskBytes;
    const sunNoVeg = decompressed.slice(offset, offset + maskBytes);
    offset += maskBytes;
    frames.push({ sun, sunNoVeg });
  }

  return { outdoor, frames };
}
