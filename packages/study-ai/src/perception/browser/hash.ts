/**
 * [browser, also Node ≥ 20] SHA-256 through Web Crypto: model verification and the camera
 * identity hash. Web Crypto exists in secure contexts only (the app's privileged scheme and
 * loopback both are).
 */

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1)
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  return out;
}

/** Lower-case hex SHA-256 of bytes, or of a string's UTF-8 encoding. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto is not available');
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const view =
    bytes.buffer instanceof ArrayBuffer
      ? (bytes as Uint8Array<ArrayBuffer>)
      : (new Uint8Array(bytes) as Uint8Array<ArrayBuffer>);
  return toHex(new Uint8Array(await subtle.digest('SHA-256', view)));
}
