import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  AttachmentStoreError,
  closeAfterFailure,
  withAttachmentResource,
  type AttachmentFileSystem,
} from "./io.js";
import { safeOpen, syncDirectory } from "./safe-open.js";

/**
 * The exclusive `writer` entry that admits one cooperative attachment writer.
 *
 * The entry is created with `wx` and holds a random token. Release verifies the entry is
 * still this inode with this token before unlinking it. That check and the unlink are not
 * atomic against other local filesystem actors; this is not a compare-and-delete lock.
 */
export interface WriterLock {
  token: string;
  dev: number;
  ino: number;
  handle: FileHandle;
}

function writerPath(root: string): string {
  return path.join(root, "writer");
}

/** Create the writer entry exclusively. Throws the open error (`EEXIST` when occupied). */
export function openWriterEntry(io: AttachmentFileSystem, root: string): Promise<FileHandle> {
  return io.open(writerPath(root), "wx", 0o600);
}

/** Identify a newly created writer entry by inode and a fresh token, closing it on failure. */
export async function identifyWriter(handle: FileHandle): Promise<WriterLock> {
  const stats = await handle
    .stat()
    .catch((error: unknown) => closeAfterFailure(error, () => handle.close()));
  return { token: randomUUID(), dev: stats.dev, ino: stats.ino, handle };
}

/** Durably write the lock's token into its entry. */
export async function publishWriterToken(
  io: AttachmentFileSystem,
  root: string,
  lock: WriterLock,
): Promise<void> {
  await lock.handle.writeFile(lock.token, "utf8");
  await lock.handle.sync();
  await syncDirectory(io, root);
}

/**
 * Close the lock's handle and remove its entry, but only if the entry is still this lock.
 * A changed or unverifiable entry is retained and reported; the handle is always closed.
 */
export async function releaseWriterLock(
  io: AttachmentFileSystem,
  root: string,
  lock: WriterLock,
): Promise<void> {
  let handleClosed = false;
  const closeHandle = async () => {
    if (handleClosed) return;
    handleClosed = true;
    await lock.handle.close();
  };
  await withAttachmentResource(async () => {
    const file = writerPath(root);
    const current = await safeOpen(io, root, file);
    await withAttachmentResource(
      async () => {
        const stats = await current.stat();
        if (
          stats.dev !== lock.dev ||
          stats.ino !== lock.ino ||
          stats.size !== Buffer.byteLength(lock.token)
        )
          throw new AttachmentStoreError(
            "Attachment writer identity changed; ownership entry retained.",
          );
        if ((await current.readFile("utf8")) !== lock.token)
          throw new AttachmentStoreError(
            "Attachment writer identity is unverifiable; ownership entry retained.",
          );
      },
      () => current.close(),
    );
    await closeHandle();
    // Cooperative owners never replace this entry. This is not compare-and-delete against external filesystem actors.
    await io.unlink(file);
    await syncDirectory(io, root);
  }, closeHandle);
}
