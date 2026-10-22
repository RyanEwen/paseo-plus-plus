import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { PASEO_BROWSER_PROFILE_PARTITION } from "./features/browser-profile.js";

// The preload runs inside Electron's sandbox and is tsc-compiled (not bundled), so at
// runtime it may only load Electron's sandbox allowlist. Any other module (local or
// third-party) emits a require() that the sandbox rejects synchronously, aborting the
// preload before contextBridge.exposeInMainWorld runs and leaving window.paseoDesktop
// undefined. That regression (0.1.108, #2103) is what this test guards against.
const SANDBOX_ALLOWLIST = new Set(["electron"]);

const preloadPath = join(dirname(fileURLToPath(import.meta.url)), "preload.ts");

// Collect every module specifier that survives to emitted JavaScript as a runtime load.
// Type-only imports/exports are erased by tsc and are therefore ignored.
function runtimeModuleSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "preload.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const specifiers: string[] = [];

  const record = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) {
      specifiers.push(node.text);
    }
  };

  const isTypeOnlyImport = (node: ts.ImportDeclaration): boolean => {
    const clause = node.importClause;
    if (!clause) {
      // Side-effect import: `import "./x.js"` — always a runtime load.
      return false;
    }
    if (clause.isTypeOnly) {
      return true;
    }
    const bindings = clause.namedBindings;
    // `import { type A, type B } from "x"` erases entirely; a default or namespace
    // binding, or any value-named binding, keeps the module at runtime.
    return (
      clause.name === undefined &&
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!isTypeOnlyImport(node)) {
        record(node.moduleSpecifier);
      }
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      record(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        record(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

describe("preload sandbox safety", () => {
  it("only loads Electron's sandbox allowlist at runtime", () => {
    const source = readFileSync(preloadPath, "utf8");
    const disallowed = runtimeModuleSpecifiers(source).filter(
      (specifier) => !SANDBOX_ALLOWLIST.has(specifier),
    );
    expect(disallowed).toEqual([]);
  });

  it("inlines the browser profile partition instead of importing it", () => {
    const source = readFileSync(preloadPath, "utf8");
    const match = source.match(/const\s+PASEO_BROWSER_PROFILE_PARTITION\s*=\s*"([^"]+)"/);
    expect(
      match,
      "PASEO_BROWSER_PROFILE_PARTITION not found as a double-quoted string literal in preload.ts",
    ).not.toBeNull();
    expect(match![1]).toBe(PASEO_BROWSER_PROFILE_PARTITION);
  });
});

describe("browser viewport preload boundary", () => {
  it.each([true, false])(
    "notifies viewport resize only for the top frame (isMainFrame=%s)",
    (isMainFrame) => {
      const source = readFileSync(
        join(dirname(preloadPath), "features/browser-keyboard/guest-preload.ts"),
        "utf8",
      );
      expect(runtimeModuleSpecifiers(source)).toEqual(["electron"]);
      const listeners = new Map<string, () => void>();
      const requests: string[] = [];
      const notifications: unknown[][] = [];
      const ipcRenderer = {
        on: () => {},
        send: (channel: string) => requests.push(channel),
        sendToHost: (...args: unknown[]) => notifications.push(args),
      };
      runInNewContext(
        ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
          exports: {},
          process: { isMainFrame },
          require: () => ({ ipcRenderer }),
          window: {
            addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
          },
        },
      );
      expect(requests).toEqual(["paseo:browser-keyboard-policy-request"]);
      expect(listeners.has("keydown")).toBe(true);
      expect(listeners.has("resize")).toBe(isMainFrame);
      listeners.get("resize")?.();
      expect(notifications).toEqual(isMainFrame ? [["paseo:browser-viewport-resized"]] : []);
    },
  );

  it("exposes the native host zoom getter without an IPC request or mutator", () => {
    let host: { window: { getCurrentWindow(): { getZoomFactor(): number } } } | undefined;
    let zoom = 1.25;
    runInNewContext(
      ts.transpileModule(readFileSync(preloadPath, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports: {},
        process: { argv: [], platform: "linux" },
        require: () => ({
          contextBridge: {
            exposeInMainWorld: (_name: string, value: typeof host) => {
              host = value;
            },
          },
          webFrame: { getZoomFactor: () => zoom },
        }),
      },
    );
    expect(host?.window.getCurrentWindow().getZoomFactor()).toBe(1.25);
    zoom = 2;
    expect(host?.window.getCurrentWindow().getZoomFactor()).toBe(2);
    expect(Object.keys(host?.window.getCurrentWindow() ?? {})).not.toContain("setZoomFactor");
  });
});

it("routes desktop profile pins and action snapshots to the exact browser context", async () => {
  let bridge:
    | {
        browser: {
          extensions: {
            actions(browserId: string): Promise<unknown>;
            setPinned(id: string, pinned: boolean): Promise<void>;
            onChanged(handler: () => void): () => void;
          };
        };
      }
    | undefined;
  const listeners = new Map<string, () => void>();
  const calls: unknown[][] = [];
  const ipcRenderer = {
    invoke: async (...args: unknown[]) => {
      calls.push(args);
    },
    on: (channel: string, listener: () => void) => listeners.set(channel, listener),
    removeListener: (channel: string, listener: () => void) => {
      expect(listeners.get(channel)).toBe(listener);
      listeners.delete(channel);
    },
  };
  runInNewContext(
    ts.transpileModule(readFileSync(preloadPath, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: {},
      process: { argv: [], platform: "linux" },
      require: () => ({
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld: (_name: string, value: typeof bridge) => {
            bridge = value;
          },
        },
      }),
    },
  );
  if (!bridge) throw new Error("Expected desktop bridge");
  await bridge.browser.extensions.setPinned("a".repeat(32), true);
  await bridge.browser.extensions.actions("background-browser");
  expect(calls).toEqual([
    ["paseo:browser:extensions:set-pinned", { id: "a".repeat(32), pinned: true }],
    ["paseo:browser:extensions:actions", { browserId: "background-browser" }],
  ]);
  let changes = 0;
  const unsubscribe = bridge.browser.extensions.onChanged(() => {
    changes += 1;
  });
  listeners.get("paseo:browser:extensions:changed")?.();
  expect(changes).toBe(1);
  unsubscribe();
  expect(listeners.size).toBe(0);
});

/** Execute the real compatibility preload with serialization across the main-world boundary. */
function extensionCompatibilityFixture(
  worker: boolean,
  readiness = true,
  manifest: Record<string, unknown> = { permissions: ["storage"] },
) {
  const callbacks = new Set<(...args: unknown[]) => void>();
  const nativeEvent = {
    addListener: (callback: (...args: unknown[]) => void) => {
      callbacks.add(callback);
    },
    removeListener: (callback: (...args: unknown[]) => void) => {
      callbacks.delete(callback);
    },
    hasListener: (callback: (...args: unknown[]) => void) => callbacks.has(callback),
    hasListeners: () => callbacks.size > 0,
  };
  const nativeSet = () => Promise.resolve();
  const nativeAccess = () => Promise.resolve();
  const nativePopup = () => Promise.resolve();
  const runtime: {
    id: string;
    getManifest(): Record<string, unknown>;
    lastError?: { message: string };
  } = { id: "a".repeat(32), getManifest: () => manifest };
  const action: Record<string, (...args: unknown[]) => unknown> = { openPopup: nativePopup };
  const browserAction: Record<string, (...args: unknown[]) => unknown> = { openPopup: nativePopup };
  const chrome = {
    runtime,
    action,
    browserAction,
    tabs: {},
    scripting: {},
    storage: {
      onChanged: { ...nativeEvent },
      session: { onChanged: { ...nativeEvent }, set: nativeSet, setAccessLevel: nativeAccess },
    },
  };
  const ipcEvents = new Map<string, (...args: unknown[]) => void>();
  const calls: unknown[][] = [];
  const context: Record<string, unknown> = {
    exports: {},
    chrome,
    location: { href: `chrome-extension://${chrome.runtime.id}/manifest.json` },
    process: { type: worker ? "service-worker" : "renderer" },
    console: { error: (...args: unknown[]) => calls.push(["console", ...args]) },
  };
  const electron = {
    ipcRenderer: {
      on: (channel: string, callback: (...args: unknown[]) => void) =>
        ipcEvents.set(channel, callback),
      invoke: (...args: unknown[]) => {
        calls.push(["invoke", ...args]);
        return Promise.resolve();
      },
      send: (...args: unknown[]) => {
        calls.push(["send", ...args]);
      },
      sendSync: (...args: unknown[]) => {
        calls.push(["sync", ...args]);
        return { ready: readiness };
      },
    },
    contextBridge: {
      exposeInMainWorld: (name: string, value: unknown) => {
        context[name] = value;
      },
      executeInMainWorld: ({
        func,
        args = [],
      }: {
        func: (...input: unknown[]) => unknown;
        args?: unknown[];
      }) => {
        context.serializedArguments = args;
        return runInNewContext(`(${func.toString()})(...serializedArguments)`, context);
      },
    },
  };
  context.require = () => electron;
  const file = join(dirname(preloadPath), "features/browser-extensions/compatibility-preload.ts");
  const source = readFileSync(file, "utf8");
  const run = () =>
    runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      context,
    );
  return {
    run,
    source,
    chrome,
    nativePopup,
    nativeSet,
    nativeAccess,
    nativeEvent,
    calls,
    callbacks,
    ipcEvents,
  };
}

describe("extension action badge compatibility preload", () => {
  it.each([
    { worker: true, declaration: "action", namespace: "action" },
    { worker: false, declaration: "browser_action", namespace: "browserAction" },
  ] as const)(
    "routes $namespace badge methods without changing native popup/storage methods",
    async ({ worker, declaration, namespace }) => {
      const f = extensionCompatibilityFixture(worker, true, {
        permissions: ["storage"],
        [declaration]: {},
      });
      f.run();
      const action = f.chrome[namespace];
      expect(action.openPopup).toBe(f.nativePopup);
      expect(f.chrome.storage.session.set).toBe(f.nativeSet);
      await action.setBadgeText({ tabId: 0, text: null });
      await action.setBadgeBackgroundColor({ color: [1, 2, 3, 255] });
      const callback = vi.fn();
      await new Promise<void>((resolve) => {
        expect(
          action.getBadgeText({ tabId: 12 }, (value: unknown) => {
            callback(value);
            resolve();
          }),
        ).toBeUndefined();
      });
      expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
      const badgeCalls = f.calls.filter((call) => {
        const packet = call[2];
        return (
          call[0] === "invoke" &&
          packet !== null &&
          typeof packet === "object" &&
          "method" in packet &&
          String(packet.method).includes("Badge")
        );
      });
      expect(badgeCalls).toEqual([
        [
          "invoke",
          "paseo:extension-compatibility",
          { method: `${namespace}.setBadgeText`, args: [{ tabId: 0, text: null }] },
        ],
        [
          "invoke",
          "paseo:extension-compatibility",
          { method: `${namespace}.setBadgeBackgroundColor`, args: [{ color: [1, 2, 3, 255] }] },
        ],
        [
          "invoke",
          "paseo:extension-compatibility",
          { method: `${namespace}.getBadgeText`, args: [{ tabId: 12 }] },
        ],
      ]);
    },
  );

  it("reports malformed badge setters through promises or callback-scoped runtime.lastError", async () => {
    const f = extensionCompatibilityFixture(true, true, { action: {} });
    f.run();
    await expect(f.chrome.action.setBadgeBackgroundColor(null)).rejects.toThrow(
      "Invalid badge details",
    );
    let errorMessage: string | undefined;
    const completed = new Promise<void>((resolve) => {
      f.chrome.action.setBadgeTextColor(null, () => {
        errorMessage = f.chrome.runtime.lastError?.message;
        resolve();
      });
    });
    await completed;
    expect(errorMessage).toContain("Invalid badge details");
    expect(f.chrome.runtime.lastError).toBeUndefined();
  });
});

describe("extension storage compatibility preload", () => {
  it("repairs worker callbacks without replacing native methods and synchronously gates entry", () => {
    const f = extensionCompatibilityFixture(true);
    f.run();
    expect(runtimeModuleSpecifiers(f.source)).toEqual(["electron"]);
    expect(f.chrome.storage.session.set).toBe(f.nativeSet);
    expect(f.chrome.storage.session.setAccessLevel).toBe(f.nativeAccess);
    expect(f.calls.filter((call) => call[0] === "sync")).toEqual([
      ["sync", "paseo:extension-storage-startup"],
    ]);
    let delivered = 0;
    const callback = () => {
      delivered += 1;
    };
    f.chrome.storage.onChanged.addListener(callback);
    f.chrome.storage.onChanged.addListener(callback);
    f.ipcEvents.get("paseo:extension-compatibility:event")!({}, "storage.onChanged", [
      { public: {} },
      "session",
    ]);
    expect(delivered).toBe(1);
    f.chrome.storage.onChanged.removeListener(callback);
    f.ipcEvents.get("paseo:extension-compatibility:event")!({}, "storage.onChanged", [
      { public: {} },
      "session",
    ]);
    expect(delivered).toBe(1);
  });

  it("leaves frame callbacks native and publishes passive readiness after native listener installation", () => {
    const f = extensionCompatibilityFixture(false);
    f.run();
    expect(f.chrome.storage.onChanged.addListener).toBe(f.nativeEvent.addListener);
    expect(f.calls.filter((call) => call[0] === "sync")).toEqual([]);
    expect(f.callbacks.size).toBe(1);
    expect(f.calls.filter((call) => call[0] === "send")).toEqual([
      ["send", "paseo:extension-storage-observer", { kind: "ready" }],
    ]);
    expect(f.chrome.storage.session.set).toBe(f.nativeSet);
  });

  it("rejects an unsuccessful readiness reply without pretending that a throw stops native background execution", () => {
    const f = extensionCompatibilityFixture(true, false);
    expect(f.run).toThrow("Extension storage observation is unavailable");
    expect(f.chrome.storage.session.set).toBe(f.nativeSet);
  });
});
