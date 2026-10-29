import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Extension, Session, ServiceWorkerMain } from "electron";
import { ipcMain, app } from "electron";
import log from "electron-log";
import {
  registerExtensionStorageObservers,
  STORAGE_OBSERVER_CHANNEL,
  STORAGE_STARTUP_CHANNEL,
} from "./storage-observers.js";
import { BrowserExtensionCatalog, type LoadedBrowserExtension } from "./catalog.js";
import * as atomicJson from "./atomic-json.js";
import { ExtensionHostCrashError } from "./runtime-failure.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-extensions-"));
  temporaryDirectories.push(directory);
  const storePath = path.join(directory, "store");
  const extension: LoadedBrowserExtension = {
    id: "a".repeat(32),
    name: "Fixture extension",
    version: "1.0",
    path: path.join(storePath, "a".repeat(32), "1.0"),
  };
  const loaded: string[] = [];
  const unloaded: string[] = [];
  const uninstalled: string[] = [];
  const loadedIds = new Set([extension.id]);
  let loadError: Error | null = null;
  const runtime = {
    isLoaded: (id: string) => loadedIds.has(id),
    async load(extensionPath: string) {
      loaded.push(extensionPath);
      if (loadError) {
        throw loadError;
      }
      loadedIds.add(extension.id);
      return extension;
    },
    unload(id: string) {
      loadedIds.delete(id);
      unloaded.push(id);
    },
    async uninstall(id: string) {
      loadedIds.delete(id);
      uninstalled.push(id);
    },
  };
  const filePath = path.join(directory, "catalog.json");
  const create = (onChanged?: () => void) =>
    new BrowserExtensionCatalog(filePath, storePath, runtime, onChanged);
  return {
    directory,
    filePath,
    extension,
    loaded,
    unloaded,
    uninstalled,
    create,
    runtime,
    unloadExternally: () => loadedIds.delete(extension.id),
    loadExternally: () => loadedIds.add(extension.id),
    isLoaded: () => loadedIds.has(extension.id),
    failLoad: () => {
      loadError = new Error("Missing extension folder");
    },
  };
}

describe("browser extension catalog", () => {
  test("repeated enable and disable requests do not reload a running extension", async () => {
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    f.failLoad();
    await catalog.setEnabled(f.extension.id, true);
    expect(f.loaded).toEqual([]);
    expect(f.unloaded).toEqual([]);
    await catalog.setEnabled(f.extension.id, false);
    await catalog.setEnabled(f.extension.id, false);
    expect(f.unloaded).toEqual([f.extension.id]);
    await expect(catalog.setEnabled(f.extension.id, true)).rejects.toThrow(
      "Missing extension folder",
    );
  });
  test.each([true, false])(
    "failed enable saves preserve only preexisting runtime state (%s)",
    async (preexisting) => {
      const f = await fixture();
      const catalog = f.create();
      await catalog.remember(f.extension);
      await catalog.setEnabled(f.extension.id, false);
      if (preexisting) {
        f.loadExternally();
      }
      await rm(f.filePath);
      await mkdir(f.filePath);
      await expect(catalog.setEnabled(f.extension.id, true)).rejects.toThrow();
      expect(f.isLoaded()).toBe(preexisting);
      expect((await catalog.list())[0].enabled).toBe(false);
      expect(f.unloaded).toEqual(preexisting ? [f.extension.id] : [f.extension.id, f.extension.id]);
    },
  );

  test("Store-page removals are forgotten without reviving deleted installations", async () => {
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    f.unloadExternally();
    expect(await catalog.list()).toEqual([]);
    expect(JSON.parse(await readFile(f.filePath, "utf8"))).toEqual([]);
  });
  test("Store installs survive restart and disabled extensions never load at startup", async () => {
    const f = await fixture();
    const catalog = f.create();
    await catalog.restore();
    await catalog.remember(f.extension);
    const restarted = f.create();
    await restarted.restore();
    expect(f.loaded).toEqual([f.extension.path]);
    expect(await restarted.list()).toEqual([
      { ...f.extension, source: "store", enabled: true, error: undefined },
    ]);

    await restarted.setEnabled(f.extension.id, false);
    expect(f.unloaded).toEqual([f.extension.id]);
    await f.create().restore();
    expect(f.loaded).toEqual([f.extension.path]);
    expect(JSON.parse(await readFile(f.filePath, "utf8"))[0].enabled).toBe(false);
  });

  test("failed startup loads stay visible with an actionable error", async () => {
    const f = await fixture();
    await f.create().remember(f.extension);
    f.failLoad();
    const restarted = f.create();
    await restarted.restore();
    expect(await restarted.list()).toEqual([
      { ...f.extension, source: "store", enabled: true, error: "Missing extension folder" },
    ]);
  });

  test("failed enable retains the saved disabled choice and future actions still work", async () => {
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    await catalog.setEnabled(f.extension.id, false);
    f.failLoad();
    await expect(catalog.setEnabled(f.extension.id, true)).rejects.toThrow(
      "Missing extension folder",
    );
    expect((await catalog.list())[0].enabled).toBe(false);
    await catalog.remove(f.extension.id);
    expect(await catalog.list()).toEqual([]);
    expect(f.uninstalled).toEqual([f.extension.id]);
  });

  test("removing unpacked extensions never deletes the user's source folder", async () => {
    const f = await fixture();
    const extension = { ...f.extension, path: path.join(f.directory, "user-extension") };
    const catalog = f.create();
    await catalog.remember(extension);
    expect((await catalog.list())[0].source).toBe("unpacked");
    await catalog.remove(extension.id);
    expect(f.unloaded).toEqual([extension.id]);
    expect(f.uninstalled).toEqual([]);
    expect(await catalog.list()).toEqual([]);
  });

  test("unreadable catalogs are preserved instead of replaced with an empty list", async () => {
    const f = await fixture();
    await writeFile(f.filePath, "broken JSON");
    await expect(f.create().restore()).rejects.toThrow();
    expect(await readFile(f.filePath, "utf8")).toBe("broken JSON");
  });
});

describe("profile-owned extension pins", () => {
  test("pins survive restart, disable/re-enable and updates; uninstall forgets the pin", async () => {
    const f = await fixture();
    const first = f.create();
    await first.remember(f.extension);
    await first.setPinned(f.extension.id, true);
    expect(JSON.parse(await readFile(f.filePath, "utf8"))[0].pinned).toBe(true);
    const restarted = f.create();
    await restarted.restore();
    expect((await restarted.list())[0].pinned).toBe(true);
    await restarted.setEnabled(f.extension.id, false);
    expect((await restarted.list())[0]).toMatchObject({ enabled: false, pinned: true });
    await restarted.setEnabled(f.extension.id, true);
    await restarted.remember({ ...f.extension, version: "2.0" });
    expect((await restarted.list())[0]).toMatchObject({ version: "2.0", pinned: true });
    await restarted.setPinned(f.extension.id, false);
    expect((await restarted.list())[0].pinned).toBe(false);
    await restarted.setPinned(f.extension.id, true);
    await restarted.remove(f.extension.id);
    expect(await restarted.list()).toEqual([]);
    f.loadExternally();
    await restarted.remember(f.extension);
    expect((await restarted.list())[0].pinned).toBeUndefined();
  });

  test("failed pin writes preserve the committed preference and never publish a change", async () => {
    const f = await fixture();
    let changes = 0;
    const catalog = f.create(() => {
      changes += 1;
    });
    await catalog.remember(f.extension);
    expect(changes).toBe(1);
    await rm(f.filePath);
    await mkdir(f.filePath);
    await expect(catalog.setPinned(f.extension.id, true)).rejects.toThrow();
    expect((await catalog.list())[0].pinned).toBeUndefined();
    expect(changes).toBe(1);
    await expect(catalog.setPinned("b".repeat(32), true)).rejects.toThrow("no longer installed");
    await rm(f.filePath, { recursive: true });
    await catalog.setPinned(f.extension.id, true);
    expect(changes).toBe(2);
    expect((await catalog.list())[0].pinned).toBe(true);
  });
});

// Observer lifetime uses the actual owner module with controllable native events; native bindings
// and windowless behavior are independently exercised by the existing extension capture fixture.
describe("storage observer runtime failures", () => {
  test.each(["remember", "enable"])(
    "%s preserves a runtime failure arriving during its pending atomic save",
    async (operation) => {
      const f = await fixture();
      const catalog = f.create();
      await catalog.remember(f.extension);
      if (operation === "enable") await catalog.setEnabled(f.extension.id, false);
      catalog.recordRuntimeFailure(f.extension.id, new Error("Storage observer failed"));
      let entered!: () => void;
      let release!: () => void;
      const saving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const write = atomicJson.writeAtomicJson;
      const save = vi
        .spyOn(atomicJson, "writeAtomicJson")
        .mockImplementationOnce(async (...args) => {
          entered();
          await resume;
          await write(...args);
        });
      try {
        const pending =
          operation === "remember"
            ? catalog.remember(f.extension)
            : catalog.setEnabled(f.extension.id, true);
        await saving;
        f.unloadExternally();
        // The same message is a NEW failure, so text equality cannot fence this race.
        catalog.recordRuntimeFailure(f.extension.id, new Error("Storage observer failed"));
        release();
        await pending;
        expect((await catalog.list())[0]).toMatchObject({
          enabled: true,
          error: "Storage observer failed",
        });
        expect(JSON.parse(await readFile(f.filePath, "utf8"))[0].enabled).toBe(true);
        expect(f.isLoaded()).toBe(false);
        await catalog.setEnabled(f.extension.id, true);
        expect((await catalog.list())[0].error).toBeUndefined();
      } finally {
        release();
        save.mockRestore();
      }
    },
  );

  test("a runtime failure remains visible without changing the durable enabled preference", async () => {
    const f = await fixture();
    let changes = 0;
    const catalog = f.create(() => {
      changes += 1;
    });
    await catalog.remember(f.extension);
    const before = await readFile(f.filePath, "utf8");
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, new Error("Storage observer failed"));
    expect((await catalog.list())[0]).toMatchObject({
      enabled: true,
      error: "Storage observer failed",
    });
    expect(await readFile(f.filePath, "utf8")).toBe(before);
    expect(changes).toBe(2);
    await catalog.setEnabled(f.extension.id, true);
    expect((await catalog.list())[0].error).toBeUndefined();
  });
});

describe("extension crash recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(log.info).mockClear();
    vi.mocked(log.error).mockClear();
  });

  function crash() {
    return new ExtensionHostCrashError({
      extensionVersion: "1.0",
      appVersion: "0.12.0-beta.3",
      exitCode: -2147483645,
      webContentsId: 104,
      nativeIdentity: { osProcessId: 20004, creationTimeMs: 1_790_000_000_104 },
    });
  }

  test("reloads only the crashed runtime, waits for readiness and keeps saved preferences intact", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    const before = await readFile(f.filePath, "utf8");
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());

    await vi.advanceTimersByTimeAsync(999);
    expect(f.loaded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(f.loaded).toEqual([f.extension.path]);
    expect((await catalog.list())[0]).toMatchObject({ enabled: true, error: undefined });
    expect(await readFile(f.filePath, "utf8")).toBe(before);
    expect(f.uninstalled).toEqual([]);
    catalog.dispose();
  });

  test("successful reloads do not reset the three-attempt crash-loop budget", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    for (const delay of [1000, 5000, 15000]) {
      f.unloadExternally();
      catalog.recordRuntimeFailure(f.extension.id, crash());
      await vi.advanceTimersByTimeAsync(delay - 1);
      const before = f.loaded.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(f.loaded).toHaveLength(before + 1);
      // Native reload/install notifications can remember a ready generation too; they cannot reset the budget.
      await catalog.remember(f.extension);
    }
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.loaded).toHaveLength(3);
    expect((await catalog.list())[0]).toMatchObject({
      enabled: true,
      error: expect.stringContaining("Retry"),
    });
    expect(log.info).toHaveBeenCalledWith(
      "[browser-extensions] crash recovery",
      expect.objectContaining({ event: "exhausted", attempt: 3 }),
    );
    await catalog.setEnabled(f.extension.id, true);
    expect(f.loaded).toHaveLength(4);
    expect((await catalog.list())[0].error).toBeUndefined();
    catalog.dispose();
  });

  test("a later crash after the ten-minute window gets a fresh bounded budget", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    await vi.advanceTimersByTimeAsync(600_000);
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.loaded).toHaveLength(2);
    expect(log.info).toHaveBeenLastCalledWith(
      "[browser-extensions] crash recovery",
      expect.objectContaining({ event: "ready", attempt: 1 }),
    );
    catalog.dispose();
  });

  test("failed reloads stop after backoff, preserve the terminal load error and redact diagnostics", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    const privateError = new Error("private-url-and-vault-payload");
    privateError.name = "private-exception-name";
    const load = vi.spyOn(f.runtime, "load").mockRejectedValue(privateError);
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    await vi.advanceTimersByTimeAsync(21_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect((await catalog.list())[0]).toMatchObject({ enabled: true, error: privateError.message });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(load).toHaveBeenCalledTimes(3);
    const diagnostics = JSON.stringify([
      vi.mocked(log.info).mock.calls,
      vi.mocked(log.error).mock.calls,
    ]);
    expect(diagnostics).not.toContain(privateError.message);
    expect(diagnostics).not.toContain(privateError.name);
    expect(diagnostics).not.toContain(f.extension.path);
    expect(log.info).toHaveBeenCalledWith(
      "[browser-extensions] crash recovery",
      expect.objectContaining({ event: "failed", errorClass: "Error" }),
    );
    catalog.dispose();
  });

  test("a new-generation crash during recovery never logs ready or creates overlapping retries", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    const nextCrash = crash();
    const load = vi.spyOn(f.runtime, "load").mockImplementationOnce(async () => {
      catalog.recordRuntimeFailure(f.extension.id, nextCrash);
      throw nextCrash;
    });
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalledWith(
      "[browser-extensions] crash recovery",
      expect.objectContaining({ event: "ready" }),
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect((await catalog.list())[0].error).toBeUndefined();
    catalog.dispose();
  });

  test("a crash after readiness resolves but before load returns cannot be reported as recovered", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    vi.spyOn(f.runtime, "load").mockImplementationOnce(async () => {
      f.loadExternally();
      catalog.recordRuntimeFailure(f.extension.id, crash());
      f.unloadExternally();
      return f.extension;
    });
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    await vi.advanceTimersByTimeAsync(1000);
    expect(log.info).not.toHaveBeenCalledWith(
      "[browser-extensions] crash recovery",
      expect.objectContaining({ event: "ready" }),
    );
    expect((await catalog.list())[0].error).toContain("Retry");
    catalog.dispose();
  });

  test.each(["disable", "remove", "shutdown"])("%s cancels scheduled recovery", async (action) => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    if (action === "disable") await catalog.setEnabled(f.extension.id, false);
    if (action === "remove") await catalog.remove(f.extension.id);
    if (action === "shutdown") catalog.dispose();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.loaded).toEqual([]);
    expect(f.isLoaded()).toBe(false);
    catalog.dispose();
  });

  test.each(["disable", "remove", "shutdown"])(
    "%s invalidates an in-flight native recovery",
    async (action) => {
      vi.useFakeTimers();
      const f = await fixture();
      const catalog = f.create();
      await catalog.remember(f.extension);
      let complete!: () => void;
      const gate = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const load = vi.spyOn(f.runtime, "load").mockImplementation(async () => {
        await gate;
        f.loadExternally();
        return f.extension;
      });
      f.unloadExternally();
      catalog.recordRuntimeFailure(f.extension.id, crash());
      await vi.advanceTimersByTimeAsync(1000);
      expect(load).toHaveBeenCalledTimes(1);
      expect(log.info).not.toHaveBeenCalledWith(
        "[browser-extensions] crash recovery",
        expect.objectContaining({ event: "ready" }),
      );
      let mutation = Promise.resolve();
      if (action === "disable") mutation = catalog.setEnabled(f.extension.id, false);
      if (action === "remove") mutation = catalog.remove(f.extension.id);
      if (action === "shutdown") catalog.dispose();
      complete();
      await mutation;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(load).toHaveBeenCalledTimes(1);
      expect(f.isLoaded()).toBe(false);
      expect(log.info).not.toHaveBeenCalledWith(
        "[browser-extensions] crash recovery",
        expect.objectContaining({ event: "ready" }),
      );
      catalog.dispose();
    },
  );

  test("disable cancels recovery already queued behind a catalog save", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = atomicJson.writeAtomicJson;
    const save = vi.spyOn(atomicJson, "writeAtomicJson").mockImplementationOnce(async (...args) => {
      await gate;
      await original(...args);
    });
    const pin = catalog.setPinned(f.extension.id, true);
    await Promise.resolve();
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    await vi.advanceTimersByTimeAsync(1000);
    const disable = catalog.setEnabled(f.extension.id, false);
    release();
    await pin;
    await disable;
    save.mockRestore();
    expect(f.loaded).toEqual([]);
    expect((await catalog.list())[0]).toMatchObject({ enabled: false, pinned: true });
    catalog.dispose();
  });

  test("plain errors, user-disabled and absent entries cannot authorize an automatic restart", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, new Error("render-process-gone; reason=crashed"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.loaded).toEqual([]);
    await catalog.setEnabled(f.extension.id, false);
    catalog.recordRuntimeFailure(f.extension.id, crash());
    catalog.recordRuntimeFailure("b".repeat(32), crash());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.loaded).toEqual([]);
    expect(f.isLoaded()).toBe(false);
    catalog.dispose();
  });

  test("disposal failure prevents loading over a still-present host", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    const unload = vi.spyOn(f.runtime, "unload").mockImplementationOnce(() => {
      throw new Error("Native unload failed");
    });
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.loaded).toEqual([]);
    expect(unload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.loaded).toEqual([f.extension.path]);
    catalog.dispose();
  });

  test("a changed extension identity is unloaded and stays terminal without repeated execution", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const catalog = f.create();
    await catalog.remember(f.extension);
    const otherId = "b".repeat(32);
    const load = vi.spyOn(f.runtime, "load").mockResolvedValue({ ...f.extension, id: otherId });
    f.unloadExternally();
    catalog.recordRuntimeFailure(f.extension.id, crash());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(f.unloaded).toContain(otherId);
    expect((await catalog.list())[0]).toMatchObject({
      id: f.extension.id,
      enabled: true,
      error: expect.stringContaining("identity changed"),
    });
    catalog.dispose();
  });
});

interface ObserverMetric {
  pid: number;
  creationTime: number;
}
interface ObserverContents extends EventEmitter {
  id: number;
  nativePid: number;
  getOSProcessId(): number;
  session: Session;
  mainFrame: { url: string; routingId: number; processId: number };
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
}
const observerNative = vi.hoisted(() => ({
  contents: [] as ObserverContents[],
  failCreate: false,
  metrics: vi.fn<() => ObserverMetric[]>(),
}));
vi.mock("electron", async () => {
  const { EventEmitter: NativeEmitter } = await import("node:events");
  return {
    app: Object.assign(new NativeEmitter(), {
      getAppMetrics: observerNative.metrics,
      getVersion: () => "0.12.0-beta.3",
    }),
    ipcMain: new NativeEmitter(),
    WebContentsView: class {
      webContents: ObserverContents;
      constructor(options: { webPreferences: { session: Session } }) {
        if (observerNative.failCreate) throw new Error("Synthetic observer construction failure");
        const contents = Object.assign(new NativeEmitter(), {
          session: options.webPreferences.session,
          id: 100 + observerNative.contents.length,
          nativePid: 20_000 + observerNative.contents.length,
          getOSProcessId() {
            return this.nativePid;
          },
          mainFrame: {
            url: "about:blank",
            routingId: observerNative.contents.length + 1,
            processId: 7,
          },
          closed: false,
          setWindowOpenHandler: vi.fn(),
          isDestroyed() {
            return this.closed;
          },
          loadURL(url: string) {
            this.mainFrame.url = url;
            return Promise.resolve();
          },
          close: vi.fn(),
        });
        contents.close.mockImplementation(() => {
          contents.closed = true;
          contents.emit("destroyed");
        });
        this.webContents = contents;
        observerNative.contents.push(contents);
      }
    },
  };
});
vi.mock("electron-log", () => ({ default: { error: vi.fn(), info: vi.fn() } }));

/** Exercise the actual lifetime owner against native-shaped failure and identity events. */
function observerFixture() {
  const extension = {
    id: "a".repeat(32),
    path: "/public/extension",
    version: "1",
    name: "Public",
    manifest: { permissions: ["storage"], background: { service_worker: "worker.js" } },
  } as Extension;
  const enabled = new Map<string, Extension>();
  const extensions = Object.assign(new EventEmitter(), {
    getExtension: (id: string) => enabled.get(id),
    removeExtension: vi.fn((id: string) => {
      const old = enabled.get(id);
      enabled.delete(id);
      if (old) extensions.emit("extension-unloaded", {}, old);
    }),
  });
  const profile = { extensions, serviceWorkers: new EventEmitter() } as unknown as Session;
  const failed = vi.fn();
  const changed = vi.fn();
  const owner = registerExtensionStorageObservers(profile, { failed, changed });
  const load = (next = extension) => {
    enabled.set(next.id, next);
    extensions.emit("extension-loaded", {}, next);
    return observerNative.contents.at(-1)!;
  };
  const frameEvent = (contents: ObserverContents) => ({
    sender: contents,
    senderFrame: { ...contents.mainFrame },
  });
  const ready = (contents: ObserverContents) =>
    ipcMain.emit(STORAGE_OBSERVER_CHANNEL, frameEvent(contents), { kind: "ready" });
  const worker = {
    versionId: 10,
    scope: `chrome-extension://${extension.id}/`,
    scriptURL: `chrome-extension://${extension.id}/worker.js`,
    ipc: new EventEmitter(),
    isDestroyed: () => false,
  } as unknown as ServiceWorkerMain;
  const replies: boolean[] = [];
  const request = () => {
    owner.trackWorker(worker);
    const event = { session: profile, serviceWorker: worker };
    Object.defineProperty(event, "returnValue", {
      set(value: { ready: boolean }) {
        replies.push(value.ready);
      },
    });
    worker.ipc.emit(STORAGE_STARTUP_CHANNEL, event);
  };
  return {
    extension,
    enabled,
    extensions,
    profile,
    owner,
    failed,
    changed,
    load,
    ready,
    frameEvent,
    request,
    replies,
    worker,
  };
}

describe("passive storage observer lifecycle", () => {
  const owners: Array<ReturnType<typeof observerFixture>> = [];
  function setup() {
    observerNative.metrics.mockImplementation(() =>
      observerNative.contents.map((contents) => ({
        pid: contents.nativePid,
        creationTime: 1_790_000_000_000 + contents.id,
      })),
    );
    const f = observerFixture();
    owners.push(f);
    return f;
  }
  afterEach(() => {
    for (const f of owners.splice(0)) f.owner.dispose();
    vi.useRealTimers();
    observerNative.contents.length = 0;
    observerNative.failCreate = false;
    observerNative.metrics.mockReset();
    vi.mocked(log.info).mockReset();
  });

  test("actual observer replacement must authenticate ready before recovery is published", async () => {
    vi.useFakeTimers();
    const f = setup();
    const files = await fixture();
    const runtime = {
      isLoaded: f.owner.isReady,
      async load() {
        f.load();
        await f.owner.waitUntilReady(f.extension);
        return f.extension;
      },
      unload: (id: string) => f.extensions.removeExtension(id),
      uninstall: async () => {},
    };
    const catalog = new BrowserExtensionCatalog(files.filePath, files.directory, runtime);
    await catalog.remember(f.extension);
    f.failed.mockImplementation((id: string, error: Error) =>
      catalog.recordRuntimeFailure(id, error),
    );
    const original = f.load();
    f.ready(original);
    await f.owner.waitUntilReady(f.extension);
    original.emit("render-process-gone", {}, { reason: "crashed", exitCode: -2147483645 });
    await vi.advanceTimersByTimeAsync(1000);
    const replacement = observerNative.contents.at(-1)!;
    expect(replacement).not.toBe(original);
    expect(f.owner.isReady(f.extension.id)).toBe(false);
    expect(log.info).not.toHaveBeenCalledWith(
      "[browser-extensions] crash recovery",
      expect.objectContaining({ event: "ready" }),
    );
    f.request();
    expect(f.replies).toEqual([]);
    f.ready(replacement);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.replies).toEqual([true]);
    expect((await catalog.list())[0]).toMatchObject({ enabled: true, error: undefined });
    expect(log.info).toHaveBeenCalledWith(
      "[browser-extensions] crash recovery",
      expect.objectContaining({ event: "ready", attempt: 1, osProcessId: original.nativePid }),
    );
    catalog.dispose();
  });

  test("a crash before observer readiness rejects startup with recovery authority and no invented native identity", async () => {
    const f = setup();
    const contents = f.load();
    const startup = f.owner.waitUntilReady(f.extension);
    const rejected = expect(startup).rejects.toBeInstanceOf(ExtensionHostCrashError);
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: -2147483645 });
    await rejected;
    expect(f.failed.mock.calls[0][1].diagnostic).toMatchObject({
      osProcessId: null,
      creationTimeMs: null,
      webContentsId: contents.id,
    });
    expect(f.owner.isReady(f.extension.id)).toBe(false);
  });

  test("only a native crashed event carries restart authority and safe cached process identity", async () => {
    const f = setup();
    const contents = f.load();
    f.ready(contents);
    await f.owner.waitUntilReady(f.extension);
    contents.emit(
      "render-process-gone",
      {},
      { reason: "crashed", exitCode: -2147483645, private: "never-log-this" },
    );
    const error = f.failed.mock.calls[0][1];
    expect(error).toBeInstanceOf(ExtensionHostCrashError);
    expect(error.diagnostic).toMatchObject({
      reason: "crashed",
      exitCode: -2147483645,
      webContentsId: contents.id,
      osProcessId: contents.nativePid,
      appVersion: "0.12.0-beta.3",
    });
    expect(JSON.stringify(error)).not.toContain("never-log-this");
    expect(f.owner.isReady(f.extension.id)).toBe(false);
    const replacement = f.load();
    f.ready(replacement);
    await f.owner.waitUntilReady(f.extension);
    // The retired generation can neither fail nor restart its replacement.
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 2 });
    expect(f.failed).toHaveBeenCalledTimes(1);
  });

  test.each(["clean-exit", "killed", "oom", "launch-failed", "abnormal-exit"])(
    "%s does not grant automatic crash recovery",
    async (reason) => {
      const f = setup();
      const contents = f.load();
      f.ready(contents);
      await f.owner.waitUntilReady(f.extension);
      contents.emit("render-process-gone", {}, { reason, exitCode: 1 });
      expect(f.failed.mock.calls[0][1]).not.toBeInstanceOf(ExtensionHostCrashError);
    },
  );

  test("only authenticated readiness publishes native PID identity and retires its exact generation", async () => {
    const f = setup();
    const old = f.load();
    const oldIdentity = {
      webContentsId: old.id,
      osProcessId: old.nativePid,
      creationTimeMs: 1_790_000_000_000 + old.id,
    };
    ipcMain.emit(
      STORAGE_OBSERVER_CHANNEL,
      { ...f.frameEvent(old), senderFrame: { ...old.mainFrame, routingId: 999 } },
      { kind: "ready", private: "SYNTHETIC_PRIVATE" },
    );
    expect(log.info).not.toHaveBeenCalled();

    f.ready(old);
    f.ready(old);
    await f.owner.waitUntilReady(f.extension);
    expect(oldIdentity.osProcessId).not.toBe(old.mainFrame.processId);
    expect(log.info).toHaveBeenCalledExactlyOnceWith("Extension storage observer native process", {
      phase: "ready",
      ...oldIdentity,
    });
    const replacement = f.load({ ...f.extension, version: "2" });
    f.ready(old);
    expect(log.info).toHaveBeenNthCalledWith(2, "Extension storage observer native process", {
      phase: "retired",
      ...oldIdentity,
    });
    f.ready(replacement);
    expect(log.info).toHaveBeenNthCalledWith(3, "Extension storage observer native process", {
      phase: "ready",
      webContentsId: replacement.id,
      osProcessId: replacement.nativePid,
      creationTimeMs: 1_790_000_000_000 + replacement.id,
    });
    expect(log.info).toHaveBeenCalledTimes(3);
  });

  test.each(["missing metrics", "invalid birth", "native query failure", "diagnostic failure"])(
    "%s cannot change readiness, replies or runtime failure cleanup",
    async (failure) => {
      const f = setup();
      const contents = f.load();
      if (failure === "missing metrics") observerNative.metrics.mockReturnValue([]);
      if (failure === "invalid birth") {
        observerNative.metrics.mockReturnValue([{ pid: contents.nativePid, creationTime: NaN }]);
      }
      if (failure === "native query failure") {
        observerNative.metrics.mockImplementation(() => {
          throw new Error("SYNTHETIC_PRIVATE");
        });
      }
      if (failure === "diagnostic failure") {
        vi.mocked(log.info).mockImplementation(() => {
          throw new Error("SYNTHETIC_PRIVATE");
        });
      }
      f.request();
      f.ready(contents);
      await f.owner.waitUntilReady(f.extension);
      expect(f.replies).toEqual([true]);
      expect(f.owner.isReady(f.extension.id)).toBe(true);
      contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: -2147483645 });
      expect(f.failed).toHaveBeenCalledExactlyOnceWith(f.extension.id, expect.any(Error));
      expect(contents.close).toHaveBeenCalledTimes(1);
      expect(f.profile.extensions.getExtension(f.extension.id)).toBeUndefined();
      expect(f.owner.isReady(f.extension.id)).toBe(false);
    },
  );

  test.each([
    {
      event: "render-process-gone",
      args: [{ reason: "oom", exitCode: -9 }],
      expected: "render-process-gone; reason=oom; exit=-9",
    },
    {
      event: "render-process-gone",
      args: [{ reason: "SYNTHETIC_PRIVATE", exitCode: Infinity }],
      expected: "render-process-gone; reason=unknown",
    },
    {
      event: "preload-error",
      args: ["/SYNTHETIC_PRIVATE/preload.js", new TypeError("SYNTHETIC_PRIVATE")],
      expected: "preload-error; class=TypeError",
    },
    {
      event: "preload-error",
      args: [
        "/SYNTHETIC_PRIVATE/preload.js",
        { name: "SYNTHETIC_PRIVATE", message: "SYNTHETIC_PRIVATE" },
      ],
      expected: "preload-error; class=Error",
    },
  ])(
    "$expected identifies failure without publishing exception payloads",
    async ({ event, args, expected }) => {
      const f = setup();
      const contents = f.load();
      f.request();
      const rejection = expect(f.owner.waitUntilReady(f.extension)).rejects.toThrow(expected);

      contents.emit(event, {}, ...args);

      await rejection;
      const error = f.failed.mock.calls[0][1] as Error;
      expect(error.message).toContain(expected);
      expect(error.message).not.toContain("SYNTHETIC_PRIVATE");
      expect(f.replies).toEqual([false]);
      expect(f.profile.extensions.getExtension(f.extension.id)).toBeUndefined();
      expect(f.owner.isReady(f.extension.id)).toBe(false);
    },
  );

  test("missing observer after construction failure unloads native runtime before readiness rejects", async () => {
    const f = setup();
    observerNative.failCreate = true;
    f.load();

    await expect(f.owner.waitUntilReady(f.extension)).rejects.toThrow(
      "Could not create the extension storage observer.",
    );
    expect(f.extensions.removeExtension).toHaveBeenCalledExactlyOnceWith(f.extension.id);
    expect(f.profile.extensions.getExtension(f.extension.id)).toBeUndefined();
    expect(f.owner.isReady(f.extension.id)).toBe(false);
    expect(f.failed).toHaveBeenCalledExactlyOnceWith(f.extension.id, expect.any(Error));
    expect(observerNative.contents).toEqual([]);
  });

  test("only the admitted native top-frame readiness releases startup and native changes", async () => {
    const f = setup();
    const contents = f.load();
    f.request();
    const published = f.owner.waitUntilReady(f.extension);
    expect(f.replies).toEqual([]);
    ipcMain.emit(
      STORAGE_OBSERVER_CHANNEL,
      { ...f.frameEvent(contents), senderFrame: { ...contents.mainFrame, routingId: 999 } },
      { kind: "ready" },
    );
    expect(f.owner.isReady(f.extension.id)).toBe(false);
    f.ready(contents);
    await published;
    expect(f.replies).toEqual([true]);
    const packet = { kind: "change", area: "session", changes: { public: { newValue: true } } };
    ipcMain.emit(STORAGE_OBSERVER_CHANNEL, f.frameEvent(contents), packet);
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(f.extension.id, packet.changes, "session");
    expect(f.failed).not.toHaveBeenCalled();
  });

  test.each(["timeout", "abort", "disable", "crash", "navigation", "dispose", "quit"])(
    "%s settles pending startup, closes the context and never publishes usable runtime",
    async (kind) => {
      vi.useFakeTimers();
      const f = setup();
      const contents = f.load();
      f.request();
      const abort = new AbortController();
      const pending = f.owner.waitUntilReady(f.extension, abort.signal);
      const rejection = expect(pending).rejects.toThrow();
      if (kind === "timeout") await vi.advanceTimersByTimeAsync(5001);
      if (kind === "abort") abort.abort();
      if (kind === "disable") f.extensions.removeExtension(f.extension.id);
      if (kind === "crash") contents.emit("render-process-gone", {}, {});
      if (kind === "navigation") contents.emit("will-navigate", { preventDefault: vi.fn() });
      if (kind === "dispose") f.owner.dispose();
      if (kind === "quit") app.emit("before-quit", {});
      await rejection;
      expect(f.replies).toEqual([false]);
      expect(contents.close).toHaveBeenCalledTimes(1);
      expect(f.extensions.removeExtension).toHaveBeenCalledWith(f.extension.id);
      expect(f.profile.extensions.getExtension(f.extension.id)).toBeUndefined();
      expect(f.owner.isReady(f.extension.id)).toBe(false);
      expect(f.changed).not.toHaveBeenCalled();
    },
  );

  test("a native unload error cannot hide observer failure or leave a pending reply", async () => {
    const f = setup();
    const contents = f.load();
    f.request();
    const pending = f.owner.waitUntilReady(f.extension);
    const rejection = expect(pending).rejects.toThrow();
    f.extensions.removeExtension.mockImplementation(() => {
      throw new Error("Synthetic native unload failure");
    });

    contents.emit("render-process-gone", {}, {});

    await rejection;
    expect(f.replies).toEqual([false]);
    expect(contents.close).toHaveBeenCalledTimes(1);
    expect(f.failed).toHaveBeenCalledExactlyOnceWith(f.extension.id, expect.any(Error));
    expect(f.owner.isReady(f.extension.id)).toBe(false);
    // Native unload failed, so this does not prove that the background entry stopped.
    expect(f.profile.extensions.getExtension(f.extension.id)).toBeDefined();
  });

  test("replacement rejects the old reply and refuses stale frame changes", async () => {
    const f = setup();
    const old = f.load();
    f.request();
    const pending = f.owner.waitUntilReady(f.extension);
    const rejected = expect(pending).rejects.toThrow("replaced");
    const replacement = f.load({ ...f.extension, version: "2" });
    await rejected;
    expect(f.replies).toEqual([false]);
    f.ready(replacement);
    await f.owner.waitUntilReady({ ...f.extension, version: "2" });
    ipcMain.emit(STORAGE_OBSERVER_CHANNEL, f.frameEvent(old), {
      kind: "change",
      area: "local",
      changes: { public: {} },
    });
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.owner.isReady(f.extension.id)).toBe(true);
  });
  test("a same-URL frame replacement cannot inherit the original source authority", async () => {
    const f = setup();
    const contents = f.load();
    f.ready(contents);
    await f.owner.waitUntilReady(f.extension);
    contents.mainFrame = { ...contents.mainFrame, routingId: 900 };
    ipcMain.emit(STORAGE_OBSERVER_CHANNEL, f.frameEvent(contents), {
      kind: "change",
      area: "local",
      changes: { public: {} },
    });
    expect(f.changed).not.toHaveBeenCalled();
    contents.emit("did-start-navigation", { isMainFrame: true });
    expect(f.owner.isReady(f.extension.id)).toBe(false);
    expect(f.failed).toHaveBeenCalledTimes(1);
  });

  test("one disconnected reply does not prevent the remaining reply and runtime retirement", async () => {
    const f = setup();
    const contents = f.load();
    f.owner.trackWorker(f.worker);
    const broken = { session: f.profile, serviceWorker: f.worker };
    Object.defineProperty(broken, "returnValue", {
      set() {
        throw new Error("Disconnected native channel");
      },
    });
    const received: boolean[] = [];
    const second = { session: f.profile, serviceWorker: f.worker };
    Object.defineProperty(second, "returnValue", {
      set(value: { ready: boolean }) {
        received.push(value.ready);
      },
    });
    f.worker.ipc.emit(STORAGE_STARTUP_CHANNEL, broken);
    f.worker.ipc.emit(STORAGE_STARTUP_CHANNEL, second);
    f.ready(contents);
    await Promise.resolve();
    expect(received).toEqual([true]);
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.owner.isReady(f.extension.id)).toBe(false);
    expect(contents.closed).toBe(true);
  });

  test("another profile's native frame can only ready its own observer", async () => {
    const first = setup();
    const second = setup();
    const one = first.load();
    const two = second.load();
    first.request();
    second.request();
    second.ready(two);
    await second.owner.waitUntilReady(second.extension);
    expect(first.replies).toEqual([]);
    expect(first.owner.isReady(first.extension.id)).toBe(false);
    first.ready(one);
    await first.owner.waitUntilReady(first.extension);
    expect(first.replies).toEqual([true]);
    expect(second.replies).toEqual([true]);
  });
});
