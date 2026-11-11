import { createHash } from "node:crypto";
import {
  ATTACHMENT_ORIGINAL_MAX_BASE64_LENGTH,
  ATTACHMENT_ORIGINAL_MAX_BYTES,
} from "@getpaseo/protocol/attachments";

/**
 * Strict image input admission shared by durable screenshot originals and provider image
 * materialization: bounded length, standard base64 with canonical padding, and a container
 * signature matching the declared type. Accepted bytes are never altered.
 */

/** Room for a `data:image/...;base64,` header on top of the encoded image. */
const IMAGE_INPUT_MAX_LENGTH = ATTACHMENT_ORIGINAL_MAX_BASE64_LENGTH + 256;
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const SIZE_LIMIT_MESSAGE = "Image input exceeds the 16 MiB attachment limit.";
const INVALID_BASE64_MESSAGE = "Image contains invalid base64 data.";

/** An image input that admission rejected; its message is safe to show the agent. */
export class ImageAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageAdmissionError";
  }
}

/** An admitted image: its exact bytes, normalized MIME type and content hash. */
export interface AdmittedImage {
  bytes: Buffer;
  mimeType: string;
  sha256: string;
}

/** Reject an over-long raw input before trimming, regex, slicing or base64 allocation. */
export function assertImageInputLength(data: string): void {
  if (data.length > IMAGE_INPUT_MAX_LENGTH) throw new ImageAdmissionError(SIZE_LIMIT_MESSAGE);
}

/** Reject encoded data that is empty or longer than the largest admissible image. */
export function assertDecodableLength(data: string): void {
  if (data.length > ATTACHMENT_ORIGINAL_MAX_BASE64_LENGTH)
    throw new ImageAdmissionError(SIZE_LIMIT_MESSAGE);
  if (!data.length) throw new ImageAdmissionError(INVALID_BASE64_MESSAGE);
}

/** Reject a decoded size above the limit. */
export function assertDecodedSize(byteLength: number): void {
  if (byteLength > ATTACHMENT_ORIGINAL_MAX_BYTES) throw new ImageAdmissionError(SIZE_LIMIT_MESSAGE);
}

/**
 * Split a `data:image/...;base64,` URL into its MIME type and payload, or trim plain base64.
 * MIME types are lowercased.
 */
export function normalizeImageData(
  mimeType: string,
  data: string,
): { mimeType: string; data: string } {
  assertImageInputLength(data);
  const trimmed = data.trim();
  if (!trimmed.startsWith("data:")) return { mimeType: mimeType.toLowerCase(), data: trimmed };

  const comma = trimmed.indexOf(",");
  if (comma < 0 || comma > 255) {
    throw new ImageAdmissionError("Image data URL has an invalid header.");
  }
  const match = /^data:(image\/[a-z0-9.+-]+);base64$/i.exec(trimmed.slice(0, comma));
  if (!match) {
    throw new ImageAdmissionError("Image data URL must contain base64 image data.");
  }
  return { mimeType: match[1].toLowerCase(), data: trimmed.slice(comma + 1) };
}

/** Whether `body` (the data before any padding) is non-empty standard base64 of a valid length. */
function isStandardBase64Body(body: string): boolean {
  // A length of 1 mod 4 cannot encode whole bytes.
  return body.length > 0 && body.length % 4 !== 1 && !/[^A-Za-z0-9+/]/.test(body);
}

/** Whether the `=` padding after `bodyLength` characters is absent, or one or two at a quartet end. */
function hasValidPadding(data: string, bodyLength: number): boolean {
  const paddingLength = data.length - bodyLength;
  if (paddingLength === 0) return true;
  return paddingLength <= 2 && data.length % 4 === 0 && /^={1,2}$/.test(data.slice(bodyLength));
}

/**
 * Whether the final character leaves no stray bits. A partial quartet encodes 4 or 2 unused
 * low bits in its last character; canonical base64 keeps them zero, so each byte string has
 * exactly one accepted encoding.
 */
function hasCanonicalTrailingBits(body: string): boolean {
  const lastDigit = BASE64_ALPHABET.indexOf(body[body.length - 1]);
  switch (body.length % 4) {
    case 2:
      return (lastDigit & 15) === 0;
    case 3:
      return (lastDigit & 3) === 0;
    default:
      return true;
  }
}

/** Decode strict, canonical, standard base64 within the size limit. */
export function decodeImageData(data: string): Buffer {
  assertDecodableLength(data);
  const paddingStart = data.indexOf("=");
  const bodyLength = paddingStart < 0 ? data.length : paddingStart;
  const body = data.slice(0, bodyLength);
  if (!isStandardBase64Body(body) || !hasValidPadding(data, bodyLength)) {
    throw new ImageAdmissionError(INVALID_BASE64_MESSAGE);
  }
  if (!hasCanonicalTrailingBits(body)) throw new ImageAdmissionError(INVALID_BASE64_MESSAGE);

  const byteLength = Math.floor((bodyLength * 3) / 4);
  assertDecodedSize(byteLength);
  const bytes = Buffer.from(data, "base64");
  if (bytes.length !== byteLength) {
    throw new ImageAdmissionError(INVALID_BASE64_MESSAGE);
  }
  return bytes;
}

/**
 * Require the bytes to start with the container signature of the declared type. Signatures
 * identify the container only; no decoder or frame/pixel safety is implied.
 */
export function assertImageSignature(bytes: Buffer, mimeType: string): void {
  let matches = false;
  switch (mimeType) {
    case "image/png":
      matches = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      break;
    case "image/jpeg":
      matches = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      break;
    case "image/gif":
      matches = ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
      break;
    case "image/webp":
      matches =
        bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
      break;
    case "image/bmp":
      matches = bytes[0] === 0x42 && bytes[1] === 0x4d;
      break;
    case "image/tiff":
      matches =
        bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 42, 0])) ||
        bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0, 42])) ||
        bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 43, 0])) ||
        bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0, 43]));
      break;
    default:
      throw new ImageAdmissionError("Image attachment format is unsupported.");
  }
  if (!matches) {
    throw new ImageAdmissionError("Image attachment does not match its declared format.");
  }
}

/** Admit one whole image: normalize, strictly decode and check its signature. */
export function admitImage(image: { data: string; mimeType: string | null }): AdmittedImage {
  const normalized = normalizeImageData(image.mimeType ?? "image/png", image.data);
  const bytes = decodeImageData(normalized.data);
  assertImageSignature(bytes, normalized.mimeType);
  return {
    bytes,
    mimeType: normalized.mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
