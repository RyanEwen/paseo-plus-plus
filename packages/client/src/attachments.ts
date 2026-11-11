import {
  ATTACHMENT_ORIGINAL_MAX_BYTES,
  ATTACHMENT_TRANSFER_CHUNK_MAX_BYTES,
  type AttachmentReference,
} from "@getpaseo/protocol/attachments";
import { FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";

/** Most original reads one client keeps in flight. */
const MAX_CONCURRENT_ORIGINAL_READS = 2;

/** DaemonClient services the transfer state machine needs. */
export interface AttachmentTransferHost {
  createRequestId(): string;
  /** Reject whoever awaits the correlated reply for `wireId`. */
  rejectWaiters(wireId: string, error: Error): void;
  /** Ask the host to stop a read. Best effort: it may throw when disconnected. */
  sendCancel(wireId: string): void;
}

type OriginalRead =
  | { phase: "pending" }
  | {
      phase: "receiving";
      mime: string;
      revision: string | undefined;
      buffer: Uint8Array;
      receivedBytes: number;
    }
  | { phase: "complete"; bytes: Uint8Array; mime: string; revision: string | undefined };

/** The admitted wire identity of one read attempt, and the caller ID that can cancel it. */
export interface OriginalReadAttempt {
  wireId: string;
  callerId: string;
}

/**
 * Client-side state for original-image reads.
 *
 * Each read attempt gets a fresh wire ID. The caller's optional request ID is only a local
 * cancellation handle that maps to the current attempt, so late frames for an earlier canceled
 * attempt can never land in a later one that reused the caller ID. Frames are admitted strictly:
 * one bounded header, chunks within the declared length and the chunk limit, then an end frame
 * at exactly that length. Any framing violation fails the read locally and asks the host to
 * cancel; no partial bytes are returned.
 */
export class AttachmentTransfers {
  private readonly reads = new Map<string, OriginalRead>();
  private readonly callerIds = new Map<string, string>();

  constructor(private readonly host: AttachmentTransferHost) {}

  /** Admit a new read attempt, or throw if the client is busy or the caller ID is unusable. */
  begin(requestId?: string): OriginalReadAttempt {
    if (this.reads.size >= MAX_CONCURRENT_ORIGINAL_READS)
      throw new Error("Original-image transfers are busy.");
    const wireId = this.host.createRequestId();
    const callerId = requestId ?? wireId;
    if (!callerId.length || callerId.length > 128)
      throw new Error("Original transfer request ID is invalid.");
    if (this.callerIds.has(callerId)) throw new Error("Transfer request ID is already active.");
    this.callerIds.set(callerId, wireId);
    this.reads.set(wireId, { phase: "pending" });
    return { wireId, callerId };
  }

  /**
   * Return the attempt's bytes after the host's terminal reply, verified against that reply's
   * reference. Throws when framing is missing, incomplete or inconsistent with the reference.
   */
  completedBytes(
    attempt: OriginalReadAttempt,
    reference: AttachmentReference,
    expected: { agentId: string; referenceId: string },
  ): Uint8Array {
    const read = this.reads.get(attempt.wireId);
    if (
      read?.phase !== "complete" ||
      read.bytes.length !== reference.byteLength ||
      read.mime !== reference.mimeType ||
      read.revision !== reference.sha256 ||
      reference.id !== expected.referenceId ||
      reference.agentId !== expected.agentId
    )
      throw new Error("Original transfer is incomplete or inconsistent.");
    return read.bytes;
  }

  /** Release an attempt's state once its caller is done with it, in any outcome. */
  finish(attempt: OriginalReadAttempt): void {
    this.reads.delete(attempt.wireId);
    if (this.callerIds.get(attempt.callerId) === attempt.wireId)
      this.callerIds.delete(attempt.callerId);
  }

  /** The current wire ID for a caller's cancellation handle, or the handle itself. */
  wireIdFor(readRequestId: string): string {
    return this.callerIds.get(readRequestId) ?? readRequestId;
  }

  /** Fail an attempt locally: free its state and reject its waiter. Ignores unknown IDs. */
  fail(wireId: string, error: Error): void {
    if (!this.reads.has(wireId)) return;
    this.reads.delete(wireId);
    for (const [callerId, candidate] of this.callerIds)
      if (candidate === wireId) this.callerIds.delete(callerId);
    this.host.rejectWaiters(wireId, error);
  }

  /**
   * Consume a file-transfer frame that belongs to an active read. Returns false for frames
   * that belong to other transfers, which the caller handles as before.
   */
  accept(frame: FileTransferFrame): boolean {
    const read = this.reads.get(frame.requestId);
    if (!read) return false;

    if (frame.opcode === FileTransferOpcode.FileBegin) {
      this.acceptHeader(frame, read);
      return true;
    }
    if (read.phase !== "receiving") {
      this.rejectFraming(frame.requestId, "Original transfer framing is incomplete or repeated.");
      return true;
    }
    if (frame.opcode === FileTransferOpcode.FileChunk) {
      this.acceptChunk(frame.requestId, read, frame.payload);
      return true;
    }
    this.acceptEnd(frame.requestId, read);
    return true;
  }

  private acceptHeader(
    frame: Extract<FileTransferFrame, { opcode: typeof FileTransferOpcode.FileBegin }>,
    read: OriginalRead,
  ): void {
    const { size, encoding } = frame.metadata;
    const invalid =
      size < 1 ||
      encoding !== "binary" ||
      size > ATTACHMENT_ORIGINAL_MAX_BYTES ||
      read.phase !== "pending";
    if (invalid) {
      this.rejectFraming(frame.requestId, "Original transfer header is invalid or repeated.");
      return;
    }
    this.reads.set(frame.requestId, {
      phase: "receiving",
      mime: frame.metadata.mime,
      revision: frame.metadata.revision,
      buffer: new Uint8Array(size),
      receivedBytes: 0,
    });
  }

  private acceptChunk(
    wireId: string,
    read: Extract<OriginalRead, { phase: "receiving" }>,
    payload: Uint8Array,
  ): void {
    if (
      payload.byteLength > ATTACHMENT_TRANSFER_CHUNK_MAX_BYTES ||
      read.receivedBytes + payload.byteLength > read.buffer.length
    ) {
      this.rejectFraming(wireId, "Original transfer exceeded its declared length or chunk limit.");
      return;
    }
    read.buffer.set(payload, read.receivedBytes);
    read.receivedBytes += payload.byteLength;
  }

  private acceptEnd(wireId: string, read: Extract<OriginalRead, { phase: "receiving" }>): void {
    if (read.receivedBytes !== read.buffer.length) {
      this.rejectFraming(wireId, "Original transfer is incomplete.");
      return;
    }
    this.reads.set(wireId, {
      phase: "complete",
      bytes: read.buffer,
      mime: read.mime,
      revision: read.revision,
    });
  }

  private rejectFraming(wireId: string, message: string): void {
    this.fail(wireId, new Error(message));
    // Local cleanup never waits for the host's cancellation acknowledgement.
    try {
      this.host.sendCancel(wireId);
    } catch {
      /* Remote cancellation is best effort after local termination. */
    }
  }
}
