import { z } from "zod";

/** Largest original image the store admits and the wire carries, in decoded bytes. */
export const ATTACHMENT_ORIGINAL_MAX_BYTES = 16 * 1024 * 1024;
/** Longest standard base64 encoding of an original at the size limit. */
export const ATTACHMENT_ORIGINAL_MAX_BASE64_LENGTH = Math.ceil(ATTACHMENT_ORIGINAL_MAX_BYTES / 3) * 4;
/** Largest payload in one original-transfer chunk frame. */
export const ATTACHMENT_TRANSFER_CHUNK_MAX_BYTES = 64 * 1024;
/** Most references one list page returns. */
export const ATTACHMENT_LIST_PAGE_MAX = 50;

export const AttachmentOwnerSchema = z.string().min(1).max(128);
export const AttachmentWorkspaceIdSchema = z.string().min(1).max(256);
export const AttachmentIdSchema = z.string().regex(/^att_[0-9a-f-]{36}$/);
export const AttachmentReferenceSchema = z.object({
  id: AttachmentIdSchema,
  agentId: AttachmentOwnerSchema,
  workspaceId: AttachmentWorkspaceIdSchema.optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().positive().max(ATTACHMENT_ORIGINAL_MAX_BYTES),
  mimeType: z.enum([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
  ]),
  createdAt: z.string().min(1).max(64),
});
export type AttachmentReference = z.infer<typeof AttachmentReferenceSchema>;

const AttachmentRequestIdSchema = z.string().min(1).max(128);
const AttachmentErrorSchema = z.string().max(512).nullable();
export const AttachmentListRequestSchema = z.object({
  type: z.literal("attachments.list.request"),
  agentId: AttachmentOwnerSchema,
  after: AttachmentIdSchema.optional(),
  limit: z.number().int().min(1).max(ATTACHMENT_LIST_PAGE_MAX).optional(),
  requestId: AttachmentRequestIdSchema,
});
export const AttachmentGetRequestSchema = z.object({
  type: z.literal("attachments.get.request"),
  agentId: AttachmentOwnerSchema,
  referenceId: AttachmentIdSchema,
  requestId: AttachmentRequestIdSchema,
});
export const AttachmentReadRequestSchema = z.object({
  type: z.literal("attachments.read.request"),
  agentId: AttachmentOwnerSchema,
  referenceId: AttachmentIdSchema,
  requestId: AttachmentRequestIdSchema,
});
export const AttachmentReadCancelRequestSchema = z.object({
  type: z.literal("attachments.read.cancel.request"),
  readRequestId: AttachmentRequestIdSchema,
  requestId: AttachmentRequestIdSchema,
});
export const AttachmentReadCancelResponseSchema = z.object({
  type: z.literal("attachments.read.cancel.response"),
  payload: z.object({
    canceled: z.boolean(),
    error: AttachmentErrorSchema,
    requestId: AttachmentRequestIdSchema,
  }),
});
export const AttachmentListResponseSchema = z.object({
  type: z.literal("attachments.list.response"),
  payload: z.object({
    references: z.array(AttachmentReferenceSchema).max(ATTACHMENT_LIST_PAGE_MAX),
    next: AttachmentIdSchema.nullable(),
    error: AttachmentErrorSchema,
    requestId: AttachmentRequestIdSchema,
  }),
});
export const AttachmentGetResponseSchema = z.object({
  type: z.literal("attachments.get.response"),
  payload: z.object({
    reference: AttachmentReferenceSchema.nullable(),
    error: AttachmentErrorSchema,
    requestId: AttachmentRequestIdSchema,
  }),
});
// Original bytes use FileBegin/Chunk/End framing; this terminal reply certifies the read/hash.
export const AttachmentReadResponseSchema = z.object({
  type: z.literal("attachments.read.response"),
  payload: z.object({
    reference: AttachmentReferenceSchema.nullable(),
    error: AttachmentErrorSchema,
    requestId: AttachmentRequestIdSchema,
  }),
});
