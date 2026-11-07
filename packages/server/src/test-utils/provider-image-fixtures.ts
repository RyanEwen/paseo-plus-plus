/** A complete 1x1 PNG that passes image admission. */
export const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Base64 for `byteLength` bytes that start with the PNG signature, so admission accepts it.
 * Large inputs keep the real materialization pipeline busy across several event-loop turns,
 * which lets tests observe a provider while its image conversion is still running.
 */
export function signedPngBase64(byteLength: number, fill: number): string {
  const bytes = Buffer.alloc(byteLength, fill);
  PNG_SIGNATURE.copy(bytes);
  return bytes.toString("base64");
}
