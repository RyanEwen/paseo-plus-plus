import { AttachmentStore, ATTACHMENT_LIMITS, attachmentFileSystem, type AttachmentFileSystem } from "./store.js";
import { mkdtemp, rm, writeFile, readFile, lstat, unlink, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PROVIDER_IMAGE_MAX_BYTES } from "../agent/providers/provider-image-output.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";


const durableFixtures: Array<{ home: string; stores: AttachmentStore[] }> = [];
async function durableFixture(
  overrides: Partial<typeof ATTACHMENT_LIMITS> = {},
  io: AttachmentFileSystem = attachmentFileSystem,
) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-durable-images-"));
  const limits = { ...ATTACHMENT_LIMITS, freeBytes: 0, closeMs: 100, ...overrides };
  const store = await AttachmentStore.create(home, limits, io);
  const fixture = { home, stores: [store] };
  durableFixtures.push(fixture);
  return {
    ...fixture,
    store,
    limits,
    async reopen() {
      const next = await AttachmentStore.create(home, limits);
      fixture.stores.push(next);
      return next;
    },
  };
}
afterEach(async () => {
  for (const fixture of durableFixtures.splice(0)) {
    for (const store of fixture.stores) await store.close().catch(() => {});
    await rm(fixture.home, { recursive: true, force: true });
  }
});
async function saveOriginal(store: AttachmentStore, agentId = "agent-a", data = PNG) {
  const writer = await store.reserve({ agentId });
  try {
    return await writer.commit({ data, mimeType: "image/png" });
  } finally {
    await writer.release();
  }
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe("durable owned screenshot originals", () => {
  test("preserves bytes, deduplicates by owner and survives a normal close/reopen", async () => {
    const fixture = await durableFixture();
    const original = await saveOriginal(fixture.store);
    expect(await saveOriginal(fixture.store)).toEqual(original);
    const other = await saveOriginal(fixture.store, "agent-b");
    expect(other.id).not.toBe(original.id);
    expect(other.sha256).toBe(original.sha256);
    expect(await readdir(path.join(fixture.home, "attachments", "blobs"))).toHaveLength(1);
    await fixture.store.close();
    const next = await fixture.reopen();
    expect(next.writable).toBe(true);
    await fixture.store.close(); // Cannot remove the successor's owner entry.
    expect(next.writable).toBe(true);
    expect(await next.get("agent-a", original.id)).toEqual(original);
    const lease = await next.openRead("agent-a", original.id, {});
    try {
      const chunks: Uint8Array[] = [];
      for await (const bytes of lease.chunks(new AbortController().signal)) chunks.push(bytes);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(PNG, "base64"));
    } finally {
      await lease.close();
    }
    expect(await saveOriginal(next)).toEqual(original);
  });
  test("listing pages through an owner's originals in capture order", async () => {
    const fixture = await durableFixture();
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const saved = [];
    for (let index = 0; index < 8; index++) {
      const data = Buffer.concat([signature, Buffer.from([index])]).toString("base64");
      saved.push((await saveOriginal(fixture.store, "agent-a", data)).id);
    }
    const paged: string[] = [];
    let after: string | undefined;
    do {
      const page = await fixture.store.list("agent-a", after, 3);
      paged.push(...page.references.map((reference) => reference.id));
      after = page.next ?? undefined;
    } while (after);
    expect(paged).toEqual(saved);
  });
  test("busy and conservative byte/count reservations reject before obtaining new image data", async () => {
    const fixture = await durableFixture({ ownerReferences: 1 });
    const writer = await fixture.store.reserve({ agentId: "agent-a" });
    await expect(fixture.store.reserve({ agentId: "agent-b" })).rejects.toThrow("busy");
    await writer.commit({ data: PNG, mimeType: "image/png" });
    await writer.release();
    await expect(fixture.store.reserve({ agentId: "agent-a" })).rejects.toThrow("quota");
    const limited = await durableFixture({ globalBytes: PROVIDER_IMAGE_MAX_BYTES });
    await expect(limited.store.reserve({ agentId: "agent-a" })).rejects.toThrow("quota");
    const fullDisk = await durableFixture({ freeBytes: Number.MAX_SAFE_INTEGER });
    await expect(fullDisk.store.reserve({ agentId: "agent-a" })).rejects.toThrow("disk");
  });
  test("cancellation before commit publishes nothing; cancellation after commit retains discovery", async () => {
    const fixture = await durableFixture();
    const signal = new AbortController();
    const writer = await fixture.store.reserve({ agentId: "agent-a" }, signal.signal);
    signal.abort();
    await expect(writer.commit({ data: PNG, mimeType: "image/png" })).rejects.toThrow();
    await writer.release();
    expect((await fixture.store.list("agent-a")).references).toHaveLength(0);
    const reference = await saveOriginal(fixture.store);
    signal.abort();
    expect((await fixture.store.list("agent-a")).references).toEqual([reference]);
    expect(await fixture.store.get("agent-a", reference.id)).toEqual(reference);
  });
  test("read-only discovery sees later committed references without acquiring another writer", async () => {
    const fixture = await durableFixture();
    const reader = await fixture.reopen();
    expect(reader.writable).toBe(false);
    expect((await reader.list("agent-a")).references).toHaveLength(0);
    const reference = await saveOriginal(fixture.store);
    expect((await reader.list("agent-a")).references).toEqual([reference]);
    expect(await reader.get("agent-a", reference.id)).toEqual(reference);
    await reader.close();
    expect(fixture.store.writable).toBe(true);
  });
  test.each(["empty", "malformed", "oversized", "symlink"])(
    "retains an occupied %s owner entry without repair while serving originals",
    async (kind) => {
      const fixture = await durableFixture();
      const reference = await saveOriginal(fixture.store);
      await fixture.store.close();
      const ownerFile = path.join(fixture.home, "attachments", "writer");
      const target = path.join(fixture.home, "outside-owner");
      if (kind === "symlink") {
        await writeFile(target, "outside-owner", { mode: 0o640 });
        await symlink(target, ownerFile);
      } else {
        let contents = "broken";
        if (kind === "oversized") contents = "x".repeat(4096);
        if (kind === "empty") contents = "";
        await writeFile(ownerFile, contents, { mode: 0o640 });
      }
      const before = await lstat(ownerFile);
      const beforeBytes = await readFile(ownerFile);
      const reader = await fixture.reopen();
      expect(reader.writable).toBe(false);
      expect(await reader.get("agent-a", reference.id)).toEqual(reference);
      await reader.close();
      const after = await lstat(ownerFile);
      expect(after.ino).toBe(before.ino);
      expect(after.mode).toBe(before.mode);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(await readFile(ownerFile)).toEqual(beforeBytes);
    },
  );
  test("close stops admission immediately and drains an admitted capture reservation", async () => {
    const fixture = await durableFixture();
    const writer = await fixture.store.reserve({ agentId: "agent-a" });
    let closed = false;
    const closing = fixture.store.close().then(() => {
      closed = true;
      return closed;
    });
    expect(fixture.store.writable).toBe(false);
    await expect(fixture.store.reserve({ agentId: "agent-b" })).rejects.toThrow("closing");
    await expect(writer.commit({ data: PNG, mimeType: "image/png" })).rejects.toThrow("closing");
    expect(closed).toBe(false);
    await writer.release();
    await closing;
    expect((await fixture.reopen()).writable).toBe(true);
  });
  test("a drain deadline retains occupancy and late capture release cannot reopen writes", async () => {
    const fixture = await durableFixture({ closeMs: 1 });
    const writer = await fixture.store.reserve({ agentId: "agent-a" });
    await expect(fixture.store.close()).rejects.toThrow("retained");
    await expect(writer.commit({ data: PNG, mimeType: "image/png" })).rejects.toThrow("closing");
    await writer.release();
    const next = await fixture.reopen();
    expect(next.writable).toBe(false);
    expect((await readdir(path.join(fixture.home, "attachments"))).includes("writer")).toBe(true);
  });
  test("publication cannot outlive ownership release", async () => {
    const entered = gate();
    const proceed = gate();
    const fixture = await durableFixture(
      {},
      {
        ...attachmentFileSystem,
        link: async (source, destination) => {
          entered.release();
          await proceed.promise;
          await attachmentFileSystem.link(source, destination);
        },
      },
    );
    const writer = await fixture.store.reserve({ agentId: "agent-a" });
    const commit = writer.commit({ data: PNG, mimeType: "image/png" });
    await entered.promise;
    const closing = fixture.store.close();
    expect((await readdir(path.join(fixture.home, "attachments"))).includes("writer")).toBe(true);
    proceed.release();
    await expect(commit).rejects.toThrow("closing");
    await writer.release();
    await closing;
    expect(await readdir(path.join(fixture.home, "attachments", "references"))).toHaveLength(0);
  });
  test("ENOSPC at reference publication retains the original as a charged orphan", async () => {
    const fixture = await durableFixture(
      {},
      {
        ...attachmentFileSystem,
        link: async (source, destination) => {
          if (String(destination).includes(`${path.sep}references${path.sep}`))
            throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
          await attachmentFileSystem.link(source, destination);
        },
      },
    );
    await expect(saveOriginal(fixture.store)).rejects.toThrow("disk full");
    expect(await readdir(path.join(fixture.home, "attachments", "blobs"))).toHaveLength(1);
    expect((await fixture.store.list("agent-a")).references).toHaveLength(0);
    await fixture.store.close();
    const constrained = await AttachmentStore.create(fixture.home, {
      ...fixture.limits,
      globalBytes: PROVIDER_IMAGE_MAX_BYTES + 8192,
    });
    fixture.stores.push(constrained);
    await expect(constrained.reserve({ agentId: "agent-a" })).rejects.toThrow("quota");
  });
  test("preserves publication failure and records later staging cleanup failure", async () => {
    const publicationFailure = Object.assign(new Error("fixture publication disk full"), {
      code: "ENOSPC",
    });
    const cleanupFailure = new Error("fixture staging cleanup failed");
    const fixture = await durableFixture(
      {},
      {
        ...attachmentFileSystem,
        link: async (source, destination) => {
          if (String(destination).includes(`${path.sep}references${path.sep}`))
            throw publicationFailure;
          await attachmentFileSystem.link(source, destination);
        },
        unlink: async (file) => {
          if (String(file).includes(`${path.sep}staging${path.sep}`)) throw cleanupFailure;
          await attachmentFileSystem.unlink(file);
        },
      },
    );
    await expect(saveOriginal(fixture.store)).rejects.toMatchObject({
      cause: publicationFailure,
      errors: [
        publicationFailure,
        expect.objectContaining({ errors: [cleanupFailure, cleanupFailure] }),
      ],
    });
    expect(await readdir(path.join(fixture.home, "attachments", "staging"))).toHaveLength(2);
    expect((await fixture.store.list("agent-a")).references).toHaveLength(0);
  });
  test("identity mismatch on normal close never removes the replacement entry", async () => {
    const fixture = await durableFixture();
    const owner = path.join(fixture.home, "attachments", "writer");
    await unlink(owner);
    await writeFile(owner, "replacement-owner");
    await expect(fixture.store.close()).rejects.toThrow("identity");
    expect(await readFile(owner, "utf8")).toBe("replacement-owner");
  });
  test("unknown retained records disable writes while valid originals remain readable", async () => {
    const fixture = await durableFixture();
    const reference = await saveOriginal(fixture.store);
    await fixture.store.close();
    await writeFile(path.join(fixture.home, "attachments", "references", "unknown.json"), "bad");
    const next = await fixture.reopen();
    expect(next.writable).toBe(false);
    expect(await next.get("agent-a", reference.id)).toEqual(reference);
    await expect(next.get("other-owner", reference.id)).rejects.toThrow("belong");
    await expect(next.get("agent-a", "../../writer")).rejects.toThrow();
  });
  test("missing and same-size corrupt originals never report successful retrieval", async () => {
    const fixture = await durableFixture();
    const reference = await saveOriginal(fixture.store);
    const blob = path.join(fixture.home, "attachments", "blobs", reference.sha256);
    await writeFile(blob, new Uint8Array(reference.byteLength));
    expect(await fixture.store.get("agent-a", reference.id)).toEqual(reference);
    const lease = await fixture.store.openRead("agent-a", reference.id, {});
    try {
      await expect(
        (async () => {
          for await (const chunk of lease.chunks(new AbortController().signal))
            expect(chunk.byteLength).toBeGreaterThan(0);
        })(),
      ).rejects.toThrow("corrupt");
    } finally {
      await lease.close();
    }
    await unlink(blob);
    await expect(fixture.store.get("agent-a", reference.id)).rejects.toThrow();
  });
  test("initialization failure releases only a fully established owned identity", async () => {
    const fixture = await durableFixture(
      {},
      {
        ...attachmentFileSystem,
        mkdir: async (directory, options) => {
          if (String(directory).endsWith(`${path.sep}staging`))
            throw new Error("fixture initialization failure");
          return attachmentFileSystem.mkdir(directory, options);
        },
      },
    );
    expect(fixture.store.writable).toBe(false);
    await fixture.store.close();
    expect((await fixture.reopen()).writable).toBe(true);
  });
  test("ownership I/O errors are distinct from occupancy and never erase existing originals", async () => {
    const fixture = await durableFixture();
    const reference = await saveOriginal(fixture.store);
    await fixture.store.close();
    const denied = await AttachmentStore.create(fixture.home, fixture.limits, {
      ...attachmentFileSystem,
      open: async (file, flags, mode) => {
        if (String(file).endsWith(`${path.sep}writer`))
          throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
        return attachmentFileSystem.open(file, flags, mode);
      },
    });
    fixture.stores.push(denied);
    expect(denied.writeError).toContain("could not be acquired");
    expect(await denied.get("agent-a", reference.id)).toEqual(reference);
    await denied.close();
    expect((await fixture.reopen()).writable).toBe(true);
  });
  test("read leases enforce global and per-session admission and release capacity", async () => {
    const fixture = await durableFixture({ globalReads: 2, sessionReads: 1 });
    const ref = await saveOriginal(fixture.store);
    const session = {};
    const first = await fixture.store.openRead("agent-a", ref.id, session);
    await expect(fixture.store.openRead("agent-a", ref.id, session)).rejects.toThrow("busy");
    const second = await fixture.store.openRead("agent-a", ref.id, {});
    await expect(fixture.store.openRead("agent-a", ref.id, {})).rejects.toThrow("busy");
    await first.close();
    await first.close();
    await second.close();
    const next = await fixture.store.openRead("agent-a", ref.id, session);
    await next.close();
  });
});

describe("attachment I/O failure preservation", () => {
  test.each(["write", "sync", "close"])(
    "staging %s failure retains the first error and a later close error",
    async (mode) => {
      const primary = Object.assign(new Error("fixture primary staging failure"), {
        code: "ENOSPC",
      });
      const closeFailure = new Error("fixture staging close failure");
      const fixture = await durableFixture(
        {},
        {
          ...attachmentFileSystem,
          open: async (file, flags, permissions) => {
            const handle = await attachmentFileSystem.open(file, flags, permissions);
            if (!String(file).includes(`${path.sep}staging${path.sep}`)) return handle;
            return new Proxy(handle, {
              get(target, key) {
                if (key === "writeFile" && mode === "write")
                  return async () => {
                    throw primary;
                  };
                if (key === "sync" && mode === "sync")
                  return async () => {
                    throw primary;
                  };
                if (key === "close")
                  return async () => {
                    await target.close();
                    throw closeFailure;
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        },
      );
      const publication = saveOriginal(fixture.store);
      if (mode === "close") await expect(publication).rejects.toBe(closeFailure);
      else
        await expect(publication).rejects.toMatchObject({
          cause: primary,
          errors: [primary, closeFailure],
        });
      expect((await fixture.store.list("agent-a")).references).toHaveLength(0);
      expect(await readdir(path.join(fixture.home, "attachments", "staging"))).toHaveLength(1);
    },
  );
  test.each(
    ["blob-verification", "directory-sync", "owner-release"].filter(
      (boundary) => boundary !== "directory-sync" || process.platform !== "win32",
    ),
  )("%s retains its operation failure if resource close also fails", async (boundary) => {
    const primary = new Error("fixture primary I/O failure");
    const closeFailure = new Error("fixture secondary close failure");
    let inject = false;
    const fixture = await durableFixture(
      {},
      {
        ...attachmentFileSystem,
        open: async (file, flags, permissions) => {
          const handle = await attachmentFileSystem.open(file, flags, permissions);
          const value = String(file);
          const blob = value.includes(`${path.sep}blobs${path.sep}`);
          const directory = value.endsWith(`${path.sep}blobs`);
          const owner = value.endsWith(`${path.sep}writer`) && flags !== "wx";
          const intercept =
            inject &&
            ((boundary === "blob-verification" && blob) ||
              (boundary === "directory-sync" && directory) ||
              (boundary === "owner-release" && owner));
          if (!intercept) return handle;
          return new Proxy(handle, {
            get(target, key) {
              if (
                (key === "read" && boundary === "blob-verification") ||
                (key === "sync" && boundary === "directory-sync") ||
                (key === "readFile" && boundary === "owner-release")
              )
                return async () => {
                  throw primary;
                };
              if (key === "close")
                return async () => {
                  await target.close();
                  throw closeFailure;
                };
              const member = Reflect.get(target, key);
              return typeof member === "function" ? member.bind(target) : member;
            },
          });
        },
      },
    );
    if (boundary !== "directory-sync") await saveOriginal(fixture.store);
    inject = true;
    const operation =
      boundary === "owner-release" ? fixture.store.close() : saveOriginal(fixture.store);
    await expect(operation).rejects.toMatchObject({
      cause: primary,
      errors: [primary, closeFailure],
    });
    if (boundary === "owner-release")
      expect(await readFile(path.join(fixture.home, "attachments", "writer"), "utf8")).toHaveLength(
        36,
      );
    inject = false;
  });
});

test("lazy send admission observes synchronous dispatch failure and releases its capacity once", async () => {
  const fixture = await durableFixture({ globalReads: 1 });
  const reference = await saveOriginal(fixture.store);
  const lease = await fixture.store.openRead("agent-a", reference.id, {});
  const failure = new Error("fixture synchronous dispatch failure");
  const attempt = lease.dispatchSend(() => {
    throw failure;
  });
  await expect(attempt).rejects.toBe(failure);
  await expect(fixture.store.openRead("agent-a", reference.id, {})).rejects.toThrow("busy");
  await lease.close();
  await lease.settled;
  const probe = await fixture.store.openRead("agent-a", reference.id, {});
  try {
    await lease.close();
    await expect(fixture.store.openRead("agent-a", reference.id, {})).rejects.toThrow("busy");
  } finally {
    await probe.close();
  }
});

test("closing an admitted lazy send before its callback prevents invocation", async () => {
  const fixture = await durableFixture({ globalReads: 1 });
  const reference = await saveOriginal(fixture.store);
  const lease = await fixture.store.openRead("agent-a", reference.id, {});
  let calls = 0;
  const attempt = lease.dispatchSend(async () => {
    calls++;
    throw new Error("Must not be invoked");
  });
  const closing = lease.close();
  await expect(attempt).rejects.toThrow("closed");
  await closing;
  await lease.settled;
  expect(calls).toBe(0);
  const probe = await fixture.store.openRead("agent-a", reference.id, {});
  await probe.close();
});
