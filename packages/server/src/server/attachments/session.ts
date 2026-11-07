import {
  FileTransferOpcode,
  encodeFileTransferFrame,
} from "@getpaseo/protocol/binary-frames/file-transfer";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { AttachmentStoreError } from "./io.js";
import type { AttachmentReadLease } from "./read-lease.js";
import type { AttachmentStore } from "./store.js";
import { withAttachmentResource } from "./io.js";

type AttachmentRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "attachments.list.request"
      | "attachments.get.request"
      | "attachments.read.request"
      | "attachments.read.cancel.request";
  }
>;
type AttachmentQuery = Exclude<AttachmentRequest, { type: "attachments.read.cancel.request" }>;
type AttachmentResponse = Extract<
  SessionOutboundMessage,
  { type: "attachments.list.response" | "attachments.get.response" | "attachments.read.response" }
>;

/** The store operations an attachment session serves; tests can supply a delegating fake. */
export type AttachmentSessionStore = Pick<AttachmentStore, "limits" | "list" | "get" | "openRead">;

/**
 * Session services the attachment session needs. Member names follow
 * `WorkspaceFilesSessionHost`: `emit` replies on a source and `emitBinary` sends one
 * acknowledged binary frame to that source.
 */
export interface AttachmentSessionHost {
  emit(message: SessionOutboundMessage, source: object): void;
  emitBinary(frame: Uint8Array, source: object): Promise<void>;
  /** Whether this physical source awaits each binary send, so it can carry original bytes. */
  hasAcknowledgedBinaryChannel(source: object): boolean;
  mayRead(): boolean;
  requestSignal(): AbortSignal;
  reportFailure?(error: unknown): void;
}

/** Wait for a dispatched send, or reject as soon as the transfer is canceled. */
function waitForTransfer<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        return resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        return reject(error);
      },
    );
  });
}

/** The failure reply for each request type: the empty result plus the error message. */
function failureResponse(
  request: AttachmentQuery,
  message: string,
): AttachmentResponse {
  const requestId = request.requestId;
  switch (request.type) {
    case "attachments.list.request":
      return {
        type: "attachments.list.response",
        payload: { references: [], next: null, error: message, requestId },
      };
    case "attachments.get.request":
      return {
        type: "attachments.get.response",
        payload: { reference: null, error: message, requestId },
      };
    case "attachments.read.request":
      return {
        type: "attachments.read.response",
        payload: { reference: null, error: message, requestId },
      };
  }
}

interface AttachmentOperation {
  cancel: AbortController;
  signal: AbortSignal;
  kind: "read" | "metadata";
  resetIdle(): void;
  clearTimers(): void;
}

/** Serves one session's attachment list, metadata, original-read and cancel requests. */
export class AttachmentSession {
  private readonly transfers = new Map<object, Map<string, AttachmentOperation>>();

  constructor(
    private readonly store: AttachmentSessionStore | undefined,
    private readonly host: AttachmentSessionHost,
  ) {}

  /** Abort every active metadata lookup and original read, e.g. after `workspace.read` is revoked. */
  revokeReads(): void {
    for (const sourceTransfers of this.transfers.values())
      for (const transfer of sourceTransfers.values())
        transfer.cancel.abort(
          new AttachmentStoreError("Original transfer permission was revoked."),
        );
  }

  /**
   * Answer one attachment request on its initiating source. Every request gets exactly one
   * reply; failures reply with the request's empty result and a user-facing message.
   */
  async handle(request: AttachmentRequest, source: object): Promise<void> {
    if (request.type === "attachments.read.cancel.request") {
      this.handleCancel(request, source);
      return;
    }

    try {
      this.host.emit(await this.answer(request, source), source);
    } catch (error) {
      this.host.reportFailure?.(error);
      const message =
        error instanceof AttachmentStoreError
          ? error.message
          : "Original attachment is unavailable or could not be read.";
      this.host.emit(failureResponse(request, message), source);
    }
  }

  private handleCancel(
    request: Extract<AttachmentRequest, { type: "attachments.read.cancel.request" }>,
    source: object,
  ): void {
    const transfer = this.transfers.get(source)?.get(request.readRequestId);
    const canceled = transfer?.kind === "read";
    if (canceled && transfer)
      transfer.cancel.abort(new AttachmentStoreError("Original transfer canceled."));
    this.host.emit(
      {
        type: "attachments.read.cancel.response",
        payload: { canceled, error: null, requestId: request.requestId },
      },
      source,
    );
  }

  /** Run a list, metadata or read request and build its success reply. */
  private async answer(request: AttachmentQuery, source: object): Promise<AttachmentResponse> {
    if (!this.host.mayRead())
      throw new AttachmentStoreError("Original attachment permission is unavailable.");
    if (!this.store)
      throw new AttachmentStoreError("Attachment storage is unavailable on this host.");

    const requestId = request.requestId;
    switch (request.type) {
      case "attachments.list.request": {
        const result = await this.store.list(request.agentId, request.after, request.limit);
        return {
          type: "attachments.list.response",
          payload: { ...result, error: null, requestId },
        };
      }
      case "attachments.get.request": {
        const reference = await this.metadata(request, source, this.store);
        return {
          type: "attachments.get.response",
          payload: { reference, error: null, requestId },
        };
      }
      case "attachments.read.request": {
        const reference = await this.read(request, source, this.store);
        return {
          type: "attachments.read.response",
          payload: { reference, error: null, requestId },
        };
      }
    }
  }

  /**
   * Register a cancelable operation under its source and request ID. It aborts when the
   * caller cancels, the session's request signal aborts, no progress happens for the idle
   * deadline (reset after each acknowledged frame), or the total deadline passes.
   */
  private beginOperation(
    source: object,
    requestId: string,
    store: AttachmentSessionStore,
    kind: AttachmentOperation["kind"],
  ): AttachmentOperation {
    if (this.transfers.get(source)?.has(requestId))
      throw new AttachmentStoreError("Original transfer request ID is already active.");
    const cancel = new AbortController();
    const signal = AbortSignal.any([cancel.signal, this.host.requestSignal()]);

    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(
        () => cancel.abort(new AttachmentStoreError("Original transfer stalled.")),
        store.limits.readIdleMs,
      );
    };
    const total = setTimeout(
      () => cancel.abort(new AttachmentStoreError("Original transfer exceeded its deadline.")),
      store.limits.readTotalMs,
    );
    const operation = {
      cancel,
      signal,
      kind,
      resetIdle,
      clearTimers: () => {
        clearTimeout(total);
        if (idle) clearTimeout(idle);
      },
    };

    const entries = this.transfers.get(source) ?? new Map<string, AttachmentOperation>();
    entries.set(requestId, operation);
    this.transfers.set(source, entries);
    resetIdle();
    return operation;
  }

  private forget(source: object, requestId: string, operation: AttachmentOperation): void {
    const entries = this.transfers.get(source);
    if (entries?.get(requestId) !== operation) return;
    entries.delete(requestId);
    if (!entries.size) this.transfers.delete(source);
  }

  private async metadata(
    request: Extract<AttachmentRequest, { type: "attachments.get.request" }>,
    source: object,
    store: AttachmentSessionStore,
  ) {
    const operation = this.beginOperation(source, request.requestId, store, "metadata");
    try {
      return await store.get(request.agentId, request.referenceId, this, operation.signal);
    } finally {
      operation.clearTimers();
      this.forget(source, request.requestId, operation);
    }
  }

  /**
   * Stream one original to its initiating source as Begin, Chunk and End frames, each
   * acknowledged before the next. The request's source and ID, and the read budget, stay
   * occupied until the lease settles: a dispatched send keeps running after the caller
   * stops waiting, and releasing early would admit an overlapping transfer.
   */
  private async read(
    request: Extract<AttachmentRequest, { type: "attachments.read.request" }>,
    source: object,
    store: AttachmentSessionStore,
  ) {
    // Check the initiating physical source before a lease or image buffer exists.
    if (!this.host.hasAcknowledgedBinaryChannel(source))
      throw new AttachmentStoreError(
        "This connection does not support acknowledged original-image transfers. Metadata remains available.",
      );
    const operation = this.beginOperation(source, request.requestId, store, "read");
    let lease: AttachmentReadLease | undefined;
    try {
      lease = await store.openRead(request.agentId, request.referenceId, this, operation.signal);
      const ownedLease = lease;
      return await withAttachmentResource(
        () => this.streamOriginal(ownedLease, request.requestId, source, operation),
        () => ownedLease.close(),
      );
    } finally {
      operation.clearTimers();
      if (lease) {
        void lease.settled.then(() => this.forget(source, request.requestId, operation));
      } else this.forget(source, request.requestId, operation);
    }
  }

  private async streamOriginal(
    lease: AttachmentReadLease,
    requestId: string,
    source: object,
    operation: AttachmentOperation,
  ) {
    // The source and permission are re-checked immediately before every frame leaves.
    const send = async (frame: Uint8Array) => {
      operation.signal.throwIfAborted();
      const pending = lease.dispatchSend(() => {
        operation.signal.throwIfAborted();
        if (!this.host.mayRead() || !this.host.hasAcknowledgedBinaryChannel(source))
          throw new AttachmentStoreError(
            "Original transfer source or permission is no longer available.",
          );
        return this.host.emitBinary(frame, source);
      });
      await waitForTransfer(operation.signal, pending);
      operation.resetIdle();
    };

    const reference = lease.reference;
    await send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: reference.mimeType,
          size: reference.byteLength,
          encoding: "binary",
          modifiedAt: reference.createdAt,
          revision: reference.sha256,
        },
      }),
    );
    for await (const chunk of lease.chunks(operation.signal))
      await send(
        encodeFileTransferFrame({ opcode: FileTransferOpcode.FileChunk, requestId, payload: chunk }),
      );
    await send(encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }));
    return reference;
  }
}
