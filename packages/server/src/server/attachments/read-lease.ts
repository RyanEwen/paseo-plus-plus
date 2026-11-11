import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { AttachmentReference } from "@getpaseo/protocol/attachments";
import { AttachmentStoreError } from "./io.js";

/** An admitted original read: its verified chunks plus the send slots that outlive callers. */
export interface AttachmentReadLease {
  reference: AttachmentReference;
  chunks(signal: AbortSignal): AsyncGenerator<Uint8Array>;
  close(): Promise<void>;
  dispatchSend(operation: () => Promise<void>): Promise<void>;
  readonly settled: Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Lifetime of one admitted original read.
 *
 * The lease opens in the `opening` phase and may be closed at any point, including before its
 * file is open. Closing stops new sends and closes the file once opening finishes. The read's
 * admission is released only when the file close has settled and every dispatched send has
 * settled: a dispatched send cannot be recalled, so its slot outlives the caller.
 */
export class ReadLease {
  private file: FileHandle | null = null;
  private closeRequested = false;
  private fileCloseSettled = false;
  private released = false;
  private pendingSends = 0;
  private closing: Promise<void> | null = null;
  private readonly opening = deferred();
  private readonly admission = deferred();

  /** Settles once the read's admission is released. */
  readonly settled = this.admission.promise;

  /**
   * @param onReleased returns the read's admission slots to the store.
   * @param onClosed runs once the file close settles, before admission can be released.
   */
  constructor(
    private readonly onReleased: () => void,
    private readonly onClosed: () => void,
  ) {}

  /** Whether close has been requested. */
  get isClosed(): boolean {
    return this.closeRequested;
  }

  /** Hand the opened file to the lease, so a close requested meanwhile also closes it. */
  attachFile(file: FileHandle): void {
    this.file = file;
  }

  /** Opening failed; let a pending or later close proceed without a file to read. */
  abandonOpening(): void {
    this.opening.resolve();
  }

  /** Finish opening and expose the read for `reference`, streamed in `chunkBytes` pieces. */
  activate(reference: AttachmentReference, chunkBytes: number): AttachmentReadLease {
    const file = this.file;
    if (!file) throw new AttachmentStoreError("Original transfer has no open file.");
    this.opening.resolve();
    return {
      reference,
      close: () => this.close(),
      dispatchSend: (operation) => this.dispatchSend(operation),
      settled: this.settled,
      chunks: (signal) => this.chunks(file, reference, chunkBytes, signal),
    };
  }

  /**
   * Start one send while the lease is open. The send occupies a slot until it settles,
   * whether or not the caller is still waiting. Throws synchronously once closed.
   */
  dispatchSend(operation: () => Promise<void>): Promise<void> {
    if (this.closeRequested) throw new AttachmentStoreError("Original transfer is closed.");
    this.pendingSends++;
    const pending = Promise.resolve().then(() => {
      if (this.closeRequested) throw new AttachmentStoreError("Original transfer is closed.");
      return operation();
    });
    // Both outcomes are observed. Caller timeout never supplies acknowledgement.
    const settle = () => {
      this.pendingSends--;
      this.releaseIfDrained();
    };
    void pending.then(settle, settle);
    return pending;
  }

  /** Stop the read and close its file once opening has finished. Idempotent. */
  close(): Promise<void> {
    this.closeRequested = true;
    this.closing ??= (async () => {
      await this.opening.promise;
      try {
        await this.file?.close();
      } finally {
        this.fileCloseSettled = true;
        this.onClosed();
        this.releaseIfDrained();
      }
    })();
    return this.closing;
  }

  private async *chunks(
    file: FileHandle,
    reference: AttachmentReference,
    chunkBytes: number,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < reference.byteLength) {
      signal.throwIfAborted();
      if (this.closeRequested) throw new AttachmentStoreError("Original transfer is closed.");
      const buffer = Buffer.alloc(Math.min(chunkBytes, reference.byteLength - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      signal.throwIfAborted();
      if (!bytesRead) throw new AttachmentStoreError("Original attachment is incomplete.");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    if (hash.digest("hex") !== reference.sha256)
      throw new AttachmentStoreError("Original attachment hash is corrupt.");
  }

  private releaseIfDrained(): void {
    if (this.released || !this.fileCloseSettled || this.pendingSends) return;
    this.released = true;
    this.onReleased();
    this.admission.resolve();
  }
}
