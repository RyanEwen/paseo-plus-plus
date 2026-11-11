import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  AttachmentIdSchema,
  AttachmentReferenceSchema,
  type AttachmentReference,
} from "@getpaseo/protocol/attachments";
import {
  AttachmentStoreError,
  closeAfterFailure,
  withAttachmentResource,
  type AttachmentFileSystem,
} from "./io.js";

/**
 * Open a regular file inside the attachment root for reading without following links.
 *
 * The root, the file's directory and the file itself must be real (non-link) entries, and the
 * opened handle must still be the inode that was checked. Windows has no O_NOFOLLOW, so it
 * relies on the lstat and identity checks alone.
 */
export async function safeOpen(
  io: AttachmentFileSystem,
  root: string,
  file: string,
  signal?: AbortSignal,
): Promise<FileHandle> {
  signal?.throwIfAborted();
  const rootStats = await io.lstat(root);
  signal?.throwIfAborted();
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
    throw new AttachmentStoreError("Attachment storage root is unsafe.");
  const directory = await io.lstat(path.dirname(file));
  signal?.throwIfAborted();
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new AttachmentStoreError("Attachment directory is unsafe.");
  const entry = await io.lstat(file);
  signal?.throwIfAborted();
  if (!entry.isFile() || entry.isSymbolicLink())
    throw new AttachmentStoreError("Original attachment is unavailable or unsafe.");

  const flags =
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await io.open(file, flags);
  try {
    signal?.throwIfAborted();
    const actual = await handle.stat();
    signal?.throwIfAborted();
    if (!actual.isFile() || actual.dev !== entry.dev || actual.ino !== entry.ino)
      throw new AttachmentStoreError("Original attachment changed while opening.");
    return handle;
  } catch (error) {
    return closeAfterFailure(error, () => handle.close());
  }
}

/** Sync a directory entry list after linking into it. */
export async function syncDirectory(io: AttachmentFileSystem, directory: string): Promise<void> {
  // Windows does not support directory fsync through Node. File data is still synced.
  if (process.platform === "win32") return;
  const handle = await io.open(directory, "r");
  await withAttachmentResource(
    () => handle.sync(),
    () => handle.close(),
  );
}

/** Read and validate one bounded reference record, rejecting a record that names another ID. */
export async function readReferenceFile(
  io: AttachmentFileSystem,
  root: string,
  id: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<AttachmentReference> {
  AttachmentIdSchema.parse(id);
  const handle = await safeOpen(io, root, path.join(root, "references", `${id}.json`), signal);
  return withAttachmentResource(
    async () => {
      const stats = await handle.stat();
      signal?.throwIfAborted();
      if (stats.size > maxBytes) throw new AttachmentStoreError("Attachment reference is corrupt.");
      const reference = AttachmentReferenceSchema.parse(JSON.parse(await handle.readFile("utf8")));
      signal?.throwIfAborted();
      if (reference.id !== id)
        throw new AttachmentStoreError("Attachment reference identity is corrupt.");
      return reference;
    },
    () => handle.close(),
  );
}
