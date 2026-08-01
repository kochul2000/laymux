/**
 * Decoding for the base64 data URLs the viewer backend sends.
 *
 * `atob` yields a binary string, so both callers need the same byte-by-byte
 * copy into a typed array; sharing it keeps the PDF and SVG previews from
 * drifting apart on how they handle a malformed payload.
 */

/**
 * Bytes behind a `data:...;base64,...` URL, or `null` if it will not decode.
 *
 * The buffer type is pinned rather than left as `ArrayBufferLike`: a plain
 * `Uint8Array` could be backed by a `SharedArrayBuffer`, which `BlobPart` does
 * not accept, and the PDF preview needs to hand these bytes to a `Blob`.
 */
export function decodeDataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** The payload decoded as UTF-8 text, or `null` if it will not decode. */
export function decodeDataUrlText(dataUrl: string): string | null {
  const bytes = decodeDataUrlBytes(dataUrl);
  if (!bytes) return null;
  // The payload is bytes, not latin-1 characters — decoding as UTF-8 keeps a
  // non-ASCII title or comment readable instead of turning it into mojibake.
  return new TextDecoder("utf-8").decode(bytes);
}
