import { AttachmentStore } from "./store.js";
import { attachmentFileSystem, type AttachmentFileSystem } from "./io.js";
import { ATTACHMENT_LIMITS, type AttachmentLimits } from "./limits.js";
import type { AttachmentReadLease } from "./read-lease.js";
import {
  AttachmentSession,
  type AttachmentSessionHost,
  type AttachmentSessionStore,
} from "./session.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { decodeFileTransferFrame, FileTransferOpcode, type FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import type { SessionOutboundMessage } from "../messages.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function attachmentSubsystem(
  options: {
    supported?: boolean;
    allowed?: boolean;
    blockFirst?: boolean;
    idleMs?: number;
    limits?: Partial<AttachmentLimits>;
    io?: AttachmentFileSystem;
    sendFailure?: Error;
    onFailure?: (error: unknown) => void;
  } = {},
) {
  const home = makeDir("attachment-session-");
  const store = await AttachmentStore.create(
    home,
    {
      ...ATTACHMENT_LIMITS,
      freeBytes: 0,
      readIdleMs: options.idleMs ?? 30_000,
      ...options.limits,
    },
    options.io,
  );
  const writer = await store.reserve({ agentId: "owner-a" });
  let reference;
  try {
    reference = await writer.commit({
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=",
      mimeType: "image/png",
    });
  } finally {
    await writer.release();
  }
  const emitted: SessionOutboundMessage[] = [];
  const frames: FileTransferFrame[] = [];
  const source = {};
  const cancellation = new AbortController();
  let unblock = () => {};
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const host: AttachmentSessionHost = {
    emit: (message) => emitted.push(message),
    hasAcknowledgedBinaryChannel: (candidate) => candidate === source && options.supported !== false,
    mayRead: () => options.allowed !== false,
    requestSignal: () => cancellation.signal,
    reportFailure: options.onFailure,
    emitBinary: async (bytes, candidate) => {
      expect(candidate).toBe(source);
      const frame = decodeFileTransferFrame(bytes);
      if (!frame) throw new Error("invalid fixture frame");
      frames.push(frame);
      began();
      if (options.sendFailure) throw options.sendFailure;
      if (options.blockFirst && frames.length === 1) await blocked;
    },
  };
  const session = new AttachmentSession(store, host);
  return {
    store,
    reference,
    session,
    host,
    source,
    cancellation,
    emitted,
    frames,
    started,
    unblock,
  };
}
describe("owned original attachment retrieval", () => {
  test("list, metadata and acknowledged bytes use the same owner reference", async () => {
    const fixture = await attachmentSubsystem();
    try {
      await fixture.session.handle(
        { type: "attachments.list.request", agentId: "owner-a", requestId: "list" },
        fixture.source,
      );
      await fixture.session.handle(
        {
          type: "attachments.get.request",
          agentId: "owner-a",
          referenceId: fixture.reference.id,
          requestId: "get",
        },
        fixture.source,
      );
      await fixture.session.handle(
        {
          type: "attachments.read.request",
          agentId: "owner-a",
          referenceId: fixture.reference.id,
          requestId: "read",
        },
        fixture.source,
      );
      expect(fixture.emitted[0]).toMatchObject({
        type: "attachments.list.response",
        payload: { references: [fixture.reference] },
      });
      expect(fixture.emitted[1]).toMatchObject({
        type: "attachments.get.response",
        payload: { reference: fixture.reference },
      });
      expect(fixture.emitted[2]).toMatchObject({
        type: "attachments.read.response",
        payload: { error: null, reference: fixture.reference },
      });
      const chunks = fixture.frames.filter(
        (frame) => frame.opcode === FileTransferOpcode.FileChunk,
      );
      expect(Buffer.concat(chunks.map((frame) => frame.payload)).length).toBe(
        fixture.reference.byteLength,
      );
      expect(fixture.frames.at(-1)?.opcode).toBe(FileTransferOpcode.FileEnd);
    } finally {
      await fixture.store.close();
    }
  });
  test("plugin-style sources retain metadata but cannot borrow another physical socket's read support", async () => {
    const fixture = await attachmentSubsystem();
    const unsupported = {};
    try {
      await fixture.session.handle(
        { type: "attachments.list.request", agentId: "owner-a", requestId: "list" },
        unsupported,
      );
      await fixture.session.handle(
        {
          type: "attachments.get.request",
          agentId: "owner-a",
          referenceId: fixture.reference.id,
          requestId: "get",
        },
        unsupported,
      );
      await fixture.session.handle(
        {
          type: "attachments.read.request",
          agentId: "owner-a",
          referenceId: fixture.reference.id,
          requestId: "bad-read",
        },
        unsupported,
      );
      expect(fixture.emitted[1]).toMatchObject({
        payload: { error: null, reference: fixture.reference },
      });
      expect(fixture.emitted[2]).toMatchObject({
        payload: { error: expect.stringContaining("acknowledged") },
      });
      expect(fixture.frames).toHaveLength(0);
    } finally {
      await fixture.store.close();
    }
  });
  test("one unacknowledged frame prevents the next chunk and cancel stays on its initiating source", async () => {
    const fixture = await attachmentSubsystem({ blockFirst: true });
    const read = fixture.session.handle(
      {
        type: "attachments.read.request",
        agentId: "owner-a",
        referenceId: fixture.reference.id,
        requestId: "read",
      },
      fixture.source,
    );
    try {
      await fixture.started;
      expect(fixture.frames).toHaveLength(1);
      await fixture.session.handle(
        {
          type: "attachments.read.cancel.request",
          readRequestId: "read",
          requestId: "other-cancel",
        },
        {},
      );
      expect(fixture.emitted.at(-1)).toMatchObject({ payload: { canceled: false } });
      await fixture.session.handle(
        { type: "attachments.read.cancel.request", readRequestId: "read", requestId: "cancel" },
        fixture.source,
      );
      await read;
      expect(fixture.frames).toHaveLength(1);
      expect(fixture.emitted.at(-1)).toMatchObject({
        type: "attachments.read.response",
        payload: { reference: null, error: expect.stringContaining("canceled") },
      });
    } finally {
      fixture.unblock();
      await read;
      await fixture.store.close();
    }
  });
  test.each(["disconnect", "timeout"])(
    "%s stops production and closes the file while retaining unacknowledged send capacity",
    async (reason) => {
      const fixture = await attachmentSubsystem({
        blockFirst: true,
        idleMs: 30_000,
        limits: { globalReads: 1 },
      });
      // Start the deadline only under the controlled clock, after fixture disk setup.
      vi.useFakeTimers();
      const read = fixture.session.handle(
        {
          type: "attachments.read.request",
          agentId: "owner-a",
          referenceId: fixture.reference.id,
          requestId: "read",
        },
        fixture.source,
      );
      try {
        await fixture.started;
        if (reason === "disconnect") fixture.cancellation.abort();
        else await vi.advanceTimersByTimeAsync(30_000);
        await read;
        vi.useRealTimers();
        expect(fixture.frames).toHaveLength(1);
        expect(fixture.emitted.at(-1)).toMatchObject({
          type: "attachments.read.response",
          payload: { reference: null, error: expect.any(String) },
        });
        await expect(fixture.store.openRead("owner-a", fixture.reference.id, {})).rejects.toThrow(
          "busy",
        );
        fixture.unblock();
        await vi.waitFor(async () => {
          const lease = await fixture.store.openRead("owner-a", fixture.reference.id, {});
          await lease.close();
        });
      } finally {
        fixture.unblock();
        await read;
        await fixture.store.close();
        vi.useRealTimers();
      }
    },
  );
  test("permission and wrong-owner failures cannot send an original", async () => {
    const denied = await attachmentSubsystem({ allowed: false });
    try {
      await denied.session.handle(
        {
          type: "attachments.read.request",
          agentId: "owner-a",
          referenceId: denied.reference.id,
          requestId: "read",
        },
        denied.source,
      );
      expect(denied.frames).toHaveLength(0);
    } finally {
      await denied.store.close();
    }
    const fixture = await attachmentSubsystem();
    try {
      await fixture.session.handle(
        {
          type: "attachments.read.request",
          agentId: "wrong-owner",
          referenceId: fixture.reference.id,
          requestId: "read",
        },
        fixture.source,
      );
      expect(fixture.frames).toHaveLength(0);
      expect(fixture.emitted.at(-1)).toMatchObject({
        payload: { error: expect.stringContaining("belong") },
      });
    } finally {
      await fixture.store.close();
    }
  });
});

function attachmentGate() {
  let resolve = () => {};
  let reject = (_error: Error) => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test.each(
  ["cancel", "disconnect", "timeout"].flatMap((reason) =>
    ["begin", "chunk"].map((boundary) => ({ reason, boundary })),
  ),
)(
  "$reason retains four dispatched $boundary slots until actual acknowledgement, scoped by source and ID",
  async ({ reason, boundary }) => {
    const fixture = await attachmentSubsystem();
    const sources = [{}, {}, {}, {}];
    const acknowledgements = sources.map(() => attachmentGate());
    const started = attachmentGate();
    const frames: Array<{ source: object; opcode: number }> = [];
    let blocked = 0;
    const replies: Array<{ source: object; message: SessionOutboundMessage }> = [];
    const deliveries = [new SessionDelivery(() => {}), new SessionDelivery(() => {})];
    const sessions = deliveries.map((delivery, index) => {
      delivery.attach(sources[index * 2], true);
      delivery.attach(sources[index * 2 + 1], true);
      return new AttachmentSession(fixture.store, {
        emit: (message, source) => {
          replies.push({ source, message });
        },
        hasAcknowledgedBinaryChannel: () => true,
        mayRead: () => true,
        requestSignal: () => delivery.requestSignal,
        emitBinary: async (bytes, source) => {
          const frame = decodeFileTransferFrame(bytes);
          if (!frame) throw new Error("invalid fixture frame");
          frames.push({ source, opcode: frame.opcode });
          if (
            frame.opcode ===
            (boundary === "begin" ? FileTransferOpcode.FileBegin : FileTransferOpcode.FileChunk)
          ) {
            if (++blocked === 4) started.resolve();
            await acknowledgements[sources.indexOf(source)].promise;
          }
        },
      });
    });
    const request = {
      type: "attachments.read.request",
      agentId: "owner-a",
      referenceId: fixture.reference.id,
      requestId: "same-id",
    } as const;
    const probeLeases: AttachmentReadLease[] = [];
    vi.useFakeTimers();
    const reads = sources.map((source, index) =>
      deliveries[Math.floor(index / 2)].request(source, request, () =>
        sessions[Math.floor(index / 2)].handle(request, source),
      ),
    );
    try {
      await started.promise;
      await sessions[0].handle(
        {
          type: "attachments.read.cancel.request",
          readRequestId: "same-id",
          requestId: "cancel-first",
        },
        sources[0],
      );
      await reads[0];
      await deliveries[0].detach(sources[0]);
      expect(
        replies.filter(
          ({ source, message }) =>
            source === sources[1] && message.type === "attachments.read.response",
        ),
      ).toHaveLength(0);
      await expect(fixture.store.openRead("owner-a", fixture.reference.id, {})).rejects.toThrow(
        "busy",
      );
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else
        for (let index = 1; index < sources.length; index++) {
          if (reason === "disconnect")
            await deliveries[Math.floor(index / 2)].detach(sources[index]);
          else
            await sessions[Math.floor(index / 2)].handle(
              {
                type: "attachments.read.cancel.request",
                readRequestId: "same-id",
                requestId: `cancel-${index}`,
              },
              sources[index],
            );
        }
      await Promise.all(reads);
      vi.useRealTimers();
      expect(frames).toHaveLength(boundary === "begin" ? 4 : 8);
      expect(frames.every((frame) => frame.opcode !== FileTransferOpcode.FileEnd)).toBe(true);
      await expect(fixture.store.openRead("owner-a", fixture.reference.id, {})).rejects.toThrow(
        "busy",
      );
      acknowledgements[0].resolve();
      const lease = await vi.waitFor(() =>
        fixture.store.openRead("owner-a", fixture.reference.id, {}),
      );
      probeLeases.push(lease);
      await expect(fixture.store.openRead("owner-a", fixture.reference.id, {})).rejects.toThrow(
        "busy",
      );
      acknowledgements[1].reject(new Error("fixture acknowledgement rejected"));
      const second = await vi.waitFor(() =>
        fixture.store.openRead("owner-a", fixture.reference.id, {}),
      );
      probeLeases.push(second);
      await expect(fixture.store.openRead("owner-a", fixture.reference.id, {})).rejects.toThrow(
        "busy",
      );
      expect(frames).toHaveLength(boundary === "begin" ? 4 : 8);
    } finally {
      vi.useRealTimers();
      for (const acknowledgement of acknowledgements) acknowledgement.resolve();
      await Promise.all(reads);
      for (const lease of probeLeases) await lease.close();
      await Promise.all(deliveries.map((delivery) => delivery.close()));
      await fixture.store.close();
    }
  },
);

test.each(["disconnect", "revoke", "timeout"])(
  "%s during metadata I/O retains admission until actual completion and reads no original chunks",
  async (reason) => {
    const entered = attachmentGate();
    const proceed = attachmentGate();
    let delay = false;
    let originalOpens = 0;
    let originalReads = 0;
    const options = {
      allowed: true,
      limits: { globalReads: 1 },
      io: {
        ...attachmentFileSystem,
        open: async (file, flags, permissions) => {
          const handle = await attachmentFileSystem.open(file, flags, permissions);
          const value = String(file);
          const blob = /[\\/]blobs[\\/]/.test(value);
          if (delay && blob) originalOpens++;
          return new Proxy(handle, {
            get(target, key) {
              if (key === "readFile" && delay && /[\\/]references[\\/]/.test(value))
                return async () => {
                  entered.resolve();
                  await proceed.promise;
                  return target.readFile("utf8");
                };
              if (key === "read" && blob)
                return async () => {
                  originalReads++;
                  throw new Error("Metadata must not read original chunks");
                };
              const member = Reflect.get(target, key);
              return typeof member === "function" ? member.bind(target) : member;
            },
          });
        },
      } satisfies AttachmentFileSystem,
    };
    const fixture = await attachmentSubsystem(options);
    delay = true;
    vi.useFakeTimers();
    const metadata = fixture.session.handle(
      {
        type: "attachments.get.request",
        agentId: "owner-a",
        referenceId: fixture.reference.id,
        requestId: "delayed-metadata",
      },
      fixture.source,
    );
    try {
      await entered.promise;
      if (reason === "disconnect") fixture.cancellation.abort();
      else if (reason === "revoke") {
        options.allowed = false;
        fixture.session.revokeReads();
      } else await vi.advanceTimersByTimeAsync(30_000);
      await expect(fixture.store.openRead("owner-a", fixture.reference.id, {})).rejects.toThrow(
        "busy",
      );
      proceed.resolve();
      await metadata;
      vi.useRealTimers();
      expect(fixture.emitted).toEqual([
        expect.objectContaining({
          type: "attachments.get.response",
          payload: expect.objectContaining({ reference: null, error: expect.any(String) }),
        }),
      ]);
      expect(originalOpens).toBe(0);
      expect(originalReads).toBe(0);
      delay = false;
      const lease = await fixture.store.openRead("owner-a", fixture.reference.id, {});
      await lease.close();
    } finally {
      vi.useRealTimers();
      proceed.resolve();
      await metadata;
      await fixture.store.close();
    }
  },
);

test.each(["complete", "send-failure"])(
  "%s with file-close failure emits one terminal result and preserves the first failure",
  async (mode) => {
    const closeFailure = new Error("fixture original handle close failed");
    const sendFailure = new Error("fixture original send failed");
    const failures: unknown[] = [];
    let closes = 0;
    const fixture = await attachmentSubsystem({
      limits: { globalReads: 1 },
      onFailure: (error) => {
        failures.push(error);
      },
      sendFailure: mode === "send-failure" ? sendFailure : undefined,
      io: {
        ...attachmentFileSystem,
        open: async (file, flags, permissions) => {
          const handle = await attachmentFileSystem.open(file, flags, permissions);
          if (!/[\\/]blobs[\\/]/.test(String(file))) return handle;
          return new Proxy(handle, {
            get(target, key) {
              if (key === "close")
                return async () => {
                  closes++;
                  await target.close();
                  throw closeFailure;
                };
              const member = Reflect.get(target, key);
              return typeof member === "function" ? member.bind(target) : member;
            },
          });
        },
      },
    });
    try {
      await fixture.session.handle(
        {
          type: "attachments.read.request",
          agentId: "owner-a",
          referenceId: fixture.reference.id,
          requestId: "close-failure",
        },
        fixture.source,
      );
      expect(closes).toBe(1);
      expect(fixture.emitted).toEqual([
        expect.objectContaining({
          type: "attachments.read.response",
          payload: expect.objectContaining({ reference: null, error: expect.any(String) }),
        }),
      ]);
      if (mode === "send-failure")
        expect(failures).toEqual([
          expect.objectContaining({ cause: sendFailure, errors: [sendFailure, closeFailure] }),
        ]);
      else {
        expect(fixture.frames.at(-1)?.opcode).toBe(FileTransferOpcode.FileEnd);
        expect(failures).toEqual([closeFailure]);
      }
      const probe = await fixture.store.openRead("owner-a", fixture.reference.id, {});
      await expect(probe.close()).rejects.toBe(closeFailure);
      expect(closes).toBe(2);
    } finally {
      await fixture.store.close();
    }
  },
);

test("a lease closed before the next send continuation never invokes the still-capable source", async () => {
  const fixture = await attachmentSubsystem({
    limits: { globalReads: 1 },
    sendFailure: new Error("Closed lease must never dispatch"),
  });
  const originalOpen = fixture.store.openRead.bind(fixture.store);
  let closedLease: AttachmentReadLease | undefined;
  // A store port whose lease is already closed when the session receives it.
  const closingStore: AttachmentSessionStore = {
    limits: fixture.store.limits,
    list: (...args) => fixture.store.list(...args),
    get: (...args) => fixture.store.get(...args),
    openRead: async (...args) => {
      const lease = await originalOpen(...args);
      closedLease = lease;
      await lease.close();
      return lease;
    },
  };
  const session = new AttachmentSession(closingStore, fixture.host);
  try {
    await session.handle(
      {
        type: "attachments.read.request",
        agentId: "owner-a",
        referenceId: fixture.reference.id,
        requestId: "closed-before-send",
      },
      fixture.source,
    );
    expect(fixture.cancellation.signal.aborted).toBe(false);
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.emitted).toEqual([
      expect.objectContaining({
        type: "attachments.read.response",
        payload: expect.objectContaining({
          reference: null,
          error: expect.stringContaining("closed"),
        }),
      }),
    ]);
    const probe = await originalOpen("owner-a", fixture.reference.id, {});
    try {
      if (!closedLease) throw new Error("Expected captured closed lease");
      await closedLease.close();
      await closedLease.settled;
      await expect(originalOpen("owner-a", fixture.reference.id, {})).rejects.toThrow("busy");
    } finally {
      await probe.close();
    }
    const next = await originalOpen("owner-a", fixture.reference.id, {});
    await next.close();
  } finally {
    await fixture.store.close();
  }
});
