import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AttachmentReferenceSchema,
  AttachmentOwnerSchema,
  type AttachmentReference,
} from "@getpaseo/protocol/attachments";
import {
  admitProviderImage,
  PROVIDER_IMAGE_MAX_BYTES,
} from "../agent/providers/provider-image-output.js";
import { AttachmentAccounting, type PublicationEffects } from "./accounting.js";
import {
  AttachmentStoreError,
  attachmentFileSystem,
  closeAfterFailure,
  hasErrnoCode,
  withAttachmentResource,
  type AttachmentFileSystem,
} from "./io.js";
import { ATTACHMENT_LIMITS, type AttachmentLimits } from "./limits.js";
import { ReadLease, type AttachmentReadLease } from "./read-lease.js";
import { AttachmentReferenceIds } from "./reference-id.js";
import { readReferenceFile, safeOpen, syncDirectory } from "./safe-open.js";
import {
  identifyWriter,
  openWriterEntry,
  publishWriterToken,
  releaseWriterLock,
  type WriterLock,
} from "./writer-lock.js";

/** A reserved capture slot: commit its image once, then always release it. */
export interface AttachmentWriter {
  commit(
    image: { data: string; mimeType: string },
    signal?: AbortSignal,
  ): Promise<AttachmentReference>;
  release(): Promise<void>;
}

/**
 * Append-only originals. No archive cleanup, stale-lock recovery or committed-file deletion.
 *
 * Orchestrates the writer lock, accounting, publication and read leases kept in sibling
 * modules. One instance holds the writer lock; any other instance is read-only.
 */
export class AttachmentStore {
  private readonly directory: string;
  private owner: WriterLock | null = null;
  private readonly accounting: AttachmentAccounting;
  private writeFailure: string | null = "Attachment storage is initializing.";
  private activeWrite: { done: Promise<void>; finish(): void } | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private reads = 0;
  private readonly readsBySession = new Map<object, number>();
  private readonly readLeases = new Set<ReadLease>();
  private refreshPromise: Promise<void> | null = null;
  private readonly referenceIds = new AttachmentReferenceIds();

  private constructor(
    home: string,
    readonly limits: AttachmentLimits,
    private readonly io: AttachmentFileSystem,
  ) {
    this.directory = path.join(home, "attachments");
    this.accounting = new AttachmentAccounting(limits);
  }

  static async create(
    home: string,
    limits: AttachmentLimits = ATTACHMENT_LIMITS,
    io: AttachmentFileSystem = attachmentFileSystem,
  ): Promise<AttachmentStore> {
    const store = new AttachmentStore(home, limits, io);
    await store.initialize();
    return store;
  }

  get writable(): boolean {
    return this.owner !== null && this.writeFailure === null && !this.closing;
  }

  get writeError(): string | null {
    return this.closing ? "Attachment storage is closing." : this.writeFailure;
  }

  /**
   * Prepare the root, try to take the writer lock and establish accounting. Every failure
   * leaves a read-capable instance with writes disabled and a reason in `writeError`.
   */
  private async initialize(): Promise<void> {
    try {
      await this.ensureRoot();

      let handle: FileHandle;
      try {
        handle = await openWriterEntry(this.io, this.directory);
      } catch (error) {
        if (hasErrnoCode(error, "EEXIST"))
          this.writeFailure =
            "Attachment writes are disabled because exclusive storage ownership is unavailable. Existing originals may still be readable.";
        else
          this.writeFailure =
            "Attachment writes are disabled because storage ownership could not be acquired.";
        await this.recover(false);
        return;
      }
      this.owner = await identifyWriter(handle);
      await publishWriterToken(this.io, this.directory, this.owner);

      await this.ensureStorageDirectories();
      this.writeFailure = null;
      await this.recover(true);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.writeFailure =
        "Attachment writes are disabled because storage initialization or accounting failed. Existing originals may still be readable.";
      // Keep the acquired identity until close; a partially written token never grants removal.
    }
  }

  private async ensureRoot(): Promise<void> {
    try {
      const existing = await this.io.lstat(this.directory);
      if (!existing.isDirectory() || existing.isSymbolicLink())
        throw new AttachmentStoreError("Attachment storage directory is unsafe.");
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) throw error;
      await this.io.mkdir(path.dirname(this.directory), { recursive: true, mode: 0o700 });
      await this.io.mkdir(this.directory, { mode: 0o700 });
      await syncDirectory(this.io, path.dirname(this.directory));
    }
  }

  private async ensureStorageDirectories(): Promise<void> {
    for (const name of ["blobs", "references", "staging"]) {
      const directory = path.join(this.directory, name);
      try {
        await this.io.mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!hasErrnoCode(error, "EEXIST")) throw error;
      }
      const directoryStats = await this.io.lstat(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink())
        throw new AttachmentStoreError("Attachment directory is unsafe.");
    }
    await syncDirectory(this.io, this.directory);
  }

  private readReference(id: string, signal?: AbortSignal): Promise<AttachmentReference> {
    return readReferenceFile(this.io, this.directory, id, this.limits.referenceBytes, signal);
  }

  /** Rescan accounting. Uncertain accounting disables writes for the writer instance. */
  private async recover(writer: boolean): Promise<void> {
    const { uncertain } = await this.accounting.scan(this.io, this.directory, (id) =>
      this.readReference(id),
    );
    if (writer && uncertain)
      this.writeFailure =
        "Attachment writes are disabled because recovered accounting is uncertain. Originals have been retained.";
  }

  /**
   * Reserve worst-case storage for one capture before it happens. Rejects when writes are
   * unavailable, another write is active, any quota would be exceeded or free disk space is
   * short, so a rejected capture never runs.
   */
  async reserve(
    owner: { agentId: string; workspaceId?: string },
    signal?: AbortSignal,
  ): Promise<AttachmentWriter> {
    AttachmentOwnerSchema.parse(owner.agentId);
    if (
      owner.workspaceId !== undefined &&
      (owner.workspaceId.length < 1 || owner.workspaceId.length > 256)
    )
      throw new AttachmentStoreError("Attachment workspace provenance is invalid.");
    signal?.throwIfAborted();
    if (!this.writable)
      throw new AttachmentStoreError(this.writeError ?? "Attachment writes are unavailable.");
    if (this.activeWrite)
      throw new AttachmentStoreError("Attachment storage is busy. No screenshot was captured.");
    if (this.accounting.exceedsQuota(owner.agentId, PROVIDER_IMAGE_MAX_BYTES))
      throw new AttachmentStoreError(
        "Attachment storage quota cannot reserve this screenshot. No screenshot was captured.",
      );

    let finish = () => {};
    const active = {
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
    };
    this.activeWrite = active;
    let operation: Promise<AttachmentReference> | null = null;
    let released = false;
    const release = async () => {
      if (operation) await operation.catch(() => {});
      if (released) return;
      released = true;
      if (this.activeWrite === active) this.activeWrite = null;
      active.finish();
    };

    try {
      const reservation = PROVIDER_IMAGE_MAX_BYTES + 2 * this.limits.entryCharge;
      const free = await this.io.statfs(this.directory);
      if (free.bavail * free.bsize < this.limits.freeBytes + reservation)
        throw new AttachmentStoreError("Attachment storage has insufficient free disk space.");
      this.assertWriteActive(signal);
      return {
        commit: (image, commitSignal) => {
          if (released || operation)
            return Promise.reject(
              new AttachmentStoreError("Attachment reservation is no longer available."),
            );
          const combined =
            signal && commitSignal
              ? AbortSignal.any([signal, commitSignal])
              : (signal ?? commitSignal);
          operation = this.commit(owner, image, combined);
          return operation;
        },
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  private assertWriteActive(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!this.writable)
      throw new AttachmentStoreError(this.writeError ?? "Attachment writes are unavailable.");
  }

  /** Write bytes to a private, synced staging file and return its path. */
  private async stage(bytes: Uint8Array): Promise<string> {
    const file = path.join(this.directory, "staging", randomUUID());
    const handle = await this.io.open(file, "wx", 0o600);
    await withAttachmentResource(
      async () => {
        await handle.writeFile(bytes);
        await handle.sync();
      },
      () => handle.close(),
    );
    return file;
  }

  /** Confirm an existing blob has the expected size and content hash. */
  private async verifyBlob(hash: string, size: number): Promise<void> {
    const handle = await safeOpen(this.io, this.directory, path.join(this.directory, "blobs", hash));
    await withAttachmentResource(
      async () => {
        if ((await handle.stat()).size !== size)
          throw new AttachmentStoreError("Original attachment is unavailable or corrupt.");
        const digest = createHash("sha256");
        const buffer = Buffer.alloc(this.limits.chunkBytes);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, size - offset),
            offset,
          );
          if (!bytesRead) throw new AttachmentStoreError("Original attachment is incomplete.");
          digest.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        if (digest.digest("hex") !== hash)
          throw new AttachmentStoreError("Original attachment hash is corrupt.");
      },
      () => handle.close(),
    );
  }

  /** Publish an admitted image, then always remove staging files and refresh accounting. */
  private async commit(
    owner: { agentId: string; workspaceId?: string },
    image: { data: string; mimeType: string },
    signal?: AbortSignal,
  ): Promise<AttachmentReference> {
    const staging = new Set<string>();
    const effects: PublicationEffects = { completed: false };
    return withAttachmentResource(
      () => this.publish(owner, image, staging, effects, signal),
      () => this.cleanupPublication(staging, effects),
      "Attachment publication failed and cleanup also failed.",
    );
  }

  /**
   * Link the image's blob (once per content hash) and then its reference record. Each file is
   * synced before its immutable name is linked; the reference link is the commit point.
   */
  private async publish(
    owner: { agentId: string; workspaceId?: string },
    image: { data: string; mimeType: string },
    staging: Set<string>,
    effects: PublicationEffects,
    signal?: AbortSignal,
  ): Promise<AttachmentReference> {
    this.assertWriteActive(signal);
    const admitted = admitProviderImage(image);
    const previous = this.accounting.findOwnedCopy(
      owner.agentId,
      admitted.sha256,
      admitted.mimeType,
    );

    const blob = path.join(this.directory, "blobs", admitted.sha256);
    try {
      await this.verifyBlob(admitted.sha256, admitted.bytes.length);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) throw error;
      const temporary = await this.stage(admitted.bytes);
      staging.add(temporary);
      this.assertWriteActive(signal);
      await this.io.link(temporary, blob);
      effects.blobBytes = admitted.bytes.length;
      await syncDirectory(this.io, path.dirname(blob));
    }
    if (previous) {
      effects.completed = true;
      return previous;
    }

    this.assertWriteActive(signal);
    const reference = AttachmentReferenceSchema.parse({
      id: this.referenceIds.next(),
      ...owner,
      sha256: admitted.sha256,
      byteLength: admitted.bytes.length,
      mimeType: admitted.mimeType,
      createdAt: new Date().toISOString(),
    });
    const metadata = Buffer.from(JSON.stringify(reference));
    if (metadata.length > this.limits.referenceBytes)
      throw new AttachmentStoreError("Attachment reference metadata exceeds its limit.");
    const temporary = await this.stage(metadata);
    staging.add(temporary);
    this.assertWriteActive(signal);
    await this.io.link(temporary, path.join(this.directory, "references", `${reference.id}.json`));
    effects.reference = reference;
    await syncDirectory(this.io, path.join(this.directory, "references"));
    // Reference publication is the commit point. Cancellation never deletes it.
    effects.completed = true;
    return reference;
  }

  /**
   * Remove a publication's staging files, then bring accounting up to date. A clean, completed
   * publication adds exactly what it linked. Any failure rescans the store, because a retained
   * staging file or a partial publication leaves charged artifacts it cannot describe.
   */
  private async cleanupPublication(
    staging: Set<string>,
    effects: PublicationEffects,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (const file of staging) {
      try {
        await this.io.unlink(file);
      } catch (error) {
        failures.push(error);
      }
    }
    if (effects.completed && !failures.length) {
      this.accounting.recordPublication(effects);
      return;
    }
    try {
      await this.recover(true);
    } catch (error) {
      this.writeFailure =
        "Attachment writes are disabled because accounting could not be established.";
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Attachment cleanup or accounting failed; original artifacts have been retained.",
      );
  }

  /**
   * One page of an owner's references. A read-only instance rescans first so it discovers
   * references another writer published; concurrent listings share one rescan.
   */
  async list(
    agentId: string,
    after?: string,
    limit = 50,
  ): Promise<{ references: AttachmentReference[]; next: string | null }> {
    AttachmentOwnerSchema.parse(agentId);
    if (!this.writable) {
      this.refreshPromise ??= this.recover(false).finally(() => {
        this.refreshPromise = null;
      });
      await this.refreshPromise;
    }
    return this.accounting.list(agentId, after, limit);
  }

  async get(
    agentId: string,
    referenceId: string,
    session: object = this,
    signal?: AbortSignal,
  ): Promise<AttachmentReference> {
    // Metadata confirms a bounded reference and safe opened blob size, not its content hash.
    const lease = await this.openRead(agentId, referenceId, session, signal);
    return withAttachmentResource(
      async () => {
        signal?.throwIfAborted();
        return lease.reference;
      },
      () => lease.close(),
    );
  }

  /**
   * Admit and open one original read for its owner. Admission is bounded globally and per
   * session and is held until the lease settles, including sends that outlive their caller.
   */
  async openRead(
    agentId: string,
    referenceId: string,
    session: object,
    signal?: AbortSignal,
  ): Promise<AttachmentReadLease> {
    signal?.throwIfAborted();
    const lease = this.admitRead(session);
    try {
      const reference = await this.readReference(referenceId, signal);
      if (reference.agentId !== agentId)
        throw new AttachmentStoreError("Attachment reference does not belong to this agent.");
      if (lease.isClosed) throw new AttachmentStoreError("Original transfer closed before opening.");
      const file = await safeOpen(
        this.io,
        this.directory,
        path.join(this.directory, "blobs", reference.sha256),
        signal,
      );
      lease.attachFile(file);
      if (lease.isClosed) throw new AttachmentStoreError("Original transfer closed while opening.");
      if ((await file.stat()).size !== reference.byteLength)
        throw new AttachmentStoreError("Original attachment is unavailable or corrupt.");
      signal?.throwIfAborted();
      return lease.activate(reference, this.limits.chunkBytes);
    } catch (error) {
      lease.abandonOpening();
      return closeAfterFailure(error, () => lease.close());
    }
  }

  private admitRead(session: object): ReadLease {
    if (
      this.closing ||
      this.reads >= this.limits.globalReads ||
      (this.readsBySession.get(session) ?? 0) >= this.limits.sessionReads
    )
      throw new AttachmentStoreError("Attachment original transfer is busy or closing.");
    this.reads++;
    this.readsBySession.set(session, (this.readsBySession.get(session) ?? 0) + 1);
    const lease: ReadLease = new ReadLease(
      () => this.releaseRead(session),
      () => this.readLeases.delete(lease),
    );
    this.readLeases.add(lease);
    return lease;
  }

  private releaseRead(session: object): void {
    this.reads--;
    const count = (this.readsBySession.get(session) ?? 1) - 1;
    if (count) this.readsBySession.set(session, count);
    else this.readsBySession.delete(session);
  }

  close(): Promise<void> {
    this.closing = true;
    this.closePromise ??= this.drainAndClose();
    return this.closePromise;
  }

  /**
   * Freeze admission, wait for the active write within `closeMs`, then close reads and release
   * the writer lock. A timed-out drain keeps the lock entry and only closes its handle.
   */
  private async drainAndClose(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const drain = this.activeWrite?.done ?? Promise.resolve();
      await Promise.race([
        drain,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new AttachmentStoreError(
                  "Attachment mutations did not drain; writer ownership has been retained.",
                ),
              ),
            this.limits.closeMs,
          );
        }),
      ]);
    } catch (error) {
      return closeAfterFailure(error, async () => {
        await this.owner?.handle.close();
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    const reads = [...this.readLeases].map((lease) => lease.close());
    const readResults = Promise.allSettled(reads);
    const owner = this.owner;
    this.owner = null;
    await withAttachmentResource(
      async () => {
        if (owner) await releaseWriterLock(this.io, this.directory, owner);
      },
      async () => {
        const failures = (await readResults)
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length)
          throw new AggregateError(failures, "Attachment read handles could not all close.", {
            cause: failures[0],
          });
      },
    );
  }
}
