import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_DATA_URI_LENGTH = 128 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Validate renderer PNG input before native decoding can allocate its pixel buffer.
 * Accept only square images up to 128 pixels and 128 KiB of encoded input.
 * The native decoder still validates the full image after this header check.
 */
export function readNotificationIconBytes(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length > MAX_DATA_URI_LENGTH) return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || width > 128 || width !== height) return null;
  return bytes;
}

/** Keep a complete, content-addressed PNG in an app-owned directory.
 * Files stay available to Windows history across app restarts. Repair corrupted
 * entries atomically, without exposing a partially written image to the shell.
 */
export async function cacheNotificationIcon(input: {
  directory: string;
  bytes: Buffer;
}): Promise<string> {
  const fingerprint = createHash("sha256").update(input.bytes).digest("hex");
  const iconPath = join(input.directory, `${fingerprint}.png`);
  try {
    if ((await readFile(iconPath)).equals(input.bytes)) return iconPath;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await mkdir(input.directory, { recursive: true });
  const temporaryPath = `${iconPath}.tmp.${randomUUID()}`;
  try {
    await writeFile(temporaryPath, input.bytes, { flag: "wx" });
    await rename(temporaryPath, iconPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return iconPath;
}
