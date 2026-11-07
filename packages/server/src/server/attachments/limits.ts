/**
 * Attachment storage limits. Byte and count quotas bound originals on disk; read limits bound
 * concurrent original transfers and their deadlines.
 */
export const ATTACHMENT_LIMITS = {
  globalBytes: 1024 * 1024 * 1024,
  ownerBytes: 256 * 1024 * 1024,
  globalReferences: 4096,
  ownerReferences: 512,
  blobFiles: 4096,
  referenceBytes: 2048,
  entryCharge: 4096,
  metadataBytes: 32 * 1024 * 1024,
  freeBytes: 512 * 1024 * 1024,
  scanEntries: 16384,
  globalReads: 4,
  sessionReads: 2,
  chunkBytes: 64 * 1024,
  readIdleMs: 30_000,
  readTotalMs: 300_000,
  closeMs: 30_000,
};
export type AttachmentLimits = typeof ATTACHMENT_LIMITS;
