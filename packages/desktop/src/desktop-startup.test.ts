import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { configureDesktopRendererClient, runDesktopStartup } from "./desktop-startup";

describe("desktop startup", () => {
  it("runs CLI passthrough before GUI login-shell env inheritance", async () => {
    const calls: string[] = [];
    await runDesktopStartup({
      hasPendingGuiLaunchRequest: false,
      runCliPassthroughIfRequested: vi.fn(async () => {
        calls.push("cli");
        return true;
      }),
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(calls).toEqual(["cli"]);
  });

  it("keeps login-shell env inheritance on normal GUI startup", async () => {
    const calls: string[] = [];
    await runDesktopStartup({
      hasPendingGuiLaunchRequest: false,
      runCliPassthroughIfRequested: vi.fn(async () => {
        calls.push("cli");
        return false;
      }),
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(calls).toEqual(["cli", "env", "gui"]);
  });

  it("does not route open-project launches through CLI passthrough", async () => {
    const runCliPassthroughIfRequested = vi.fn(async () => true);
    const calls: string[] = [];

    await runDesktopStartup({
      hasPendingGuiLaunchRequest: true,
      runCliPassthroughIfRequested,
      inheritLoginShellEnv: vi.fn(() => calls.push("env")),
      bootstrapGui: vi.fn(async () => {
        calls.push("gui");
      }),
    });

    expect(runCliPassthroughIfRequested).not.toHaveBeenCalled();
    expect(calls).toEqual(["env", "gui"]);
  });
});

interface RendererClientCase {
  name: string;
  platform: NodeJS.Platform;
  realUserId: number | undefined;
  initialFlags: string[];
  expectedAppends: string[];
}

describe("desktop renderer client bootstrap", () => {
  const cases: RendererClientCase[] = [
    {
      name: "keeps OS sandbox disabled for a non-root Linux fallback",
      platform: "linux",
      realUserId: 1000,
      initialFlags: ["disable-gpu", "no-sandbox"],
      expectedAppends: ["enable-sandbox"],
    },
    {
      name: "accepts a known non-root system UID",
      platform: "linux",
      realUserId: 1,
      initialFlags: ["no-sandbox"],
      expectedAppends: ["enable-sandbox"],
    },
    {
      name: "leaves the normal sandbox default unchanged",
      platform: "linux",
      realUserId: 1000,
      initialFlags: [],
      expectedAppends: [],
    },
    {
      name: "preserves an explicit enabled client with OS sandbox disabled",
      platform: "linux",
      realUserId: 1000,
      initialFlags: ["no-sandbox", "enable-sandbox"],
      expectedAppends: [],
    },
    {
      name: "preserves an enabled client without OS fallback",
      platform: "linux",
      realUserId: 1000,
      initialFlags: ["enable-sandbox"],
      expectedAppends: [],
    },
    {
      name: "keeps root fallback startup unchanged",
      platform: "linux",
      realUserId: 0,
      initialFlags: ["no-sandbox"],
      expectedAppends: [],
    },
    {
      name: "does not rewrite explicit root user flags",
      platform: "linux",
      realUserId: 0,
      initialFlags: ["no-sandbox", "enable-sandbox"],
      expectedAppends: [],
    },
    {
      name: "leaves an unavailable real UID unchanged",
      platform: "linux",
      realUserId: undefined,
      initialFlags: ["no-sandbox"],
      expectedAppends: [],
    },
    {
      name: "does not accept a negative UID as known non-root",
      platform: "linux",
      realUserId: -1,
      initialFlags: ["no-sandbox"],
      expectedAppends: [],
    },
    {
      name: "does not accept a nonnumeric UID as known non-root",
      platform: "linux",
      realUserId: Number.NaN,
      initialFlags: ["no-sandbox"],
      expectedAppends: [],
    },
    {
      name: "does not accept a fractional UID as known non-root",
      platform: "linux",
      realUserId: 1.5,
      initialFlags: ["no-sandbox"],
      expectedAppends: [],
    },
    {
      name: "leaves Windows fallback flags unchanged",
      platform: "win32",
      realUserId: 1000,
      initialFlags: ["no-sandbox"],
      expectedAppends: [],
    },
    {
      name: "leaves macOS fallback flags unchanged",
      platform: "darwin",
      realUserId: 1000,
      initialFlags: ["no-sandbox"],
      expectedAppends: [],
    },
  ];

  it.each(cases)("$name", ({ platform, realUserId, initialFlags, expectedAppends }) => {
    const flags = new Set(initialFlags);
    const commandLine = {
      hasSwitch: vi.fn((name: string) => flags.has(name)),
      appendSwitch: vi.fn((name: string) => {
        flags.add(name);
      }),
    };
    const input = { platform, realUserId, commandLine };

    configureDesktopRendererClient(input);
    configureDesktopRendererClient(input);

    expect([...flags]).toEqual([...initialFlags, ...expectedAppends]);
    expect(commandLine.appendSwitch.mock.calls).toEqual(expectedAppends.map((name) => [name]));
  });

  it("selects the renderer client after inherited flags and before ready or contents", () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const configuration = "configureDesktopRendererClient({";
    const configurationIndex = source.indexOf(configuration);
    const hook = `configureDesktopRendererClient({
  platform: process.platform,
  realUserId: process.getuid?.(),
  commandLine: app.commandLine,
});`;

    expect(source).toContain(`  log.info("[electron-flags]", electronFlags);
}

${hook}`);
    expect(configurationIndex).toBeGreaterThan(source.indexOf("const electronFlags ="));
    expect(configurationIndex).toBeLessThan(source.indexOf("new BrowserWindow("));
    expect(configurationIndex).toBeLessThan(source.indexOf("await app.whenReady();"));
    expect(configurationIndex).toBeLessThan(source.indexOf("await registerBrowserExtensions();"));
    expect(configurationIndex).toBeLessThan(source.indexOf("void runDesktopStartup({"));
    expect(source.split(configuration)).toHaveLength(2);

    const harness = readFileSync(
      new URL("../capture-harness/main.js", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const productionImport =
      'const { configureDesktopRendererClient } = require("../dist/desktop-startup.js");';
    const harnessIndex = harness.indexOf(configuration);
    expect(harness).toContain(productionImport);
    expect(harness).toContain(hook);
    expect(harnessIndex).toBeGreaterThan(harness.indexOf(productionImport));
    expect(harnessIndex).toBeLessThan(harness.indexOf("new BrowserWindow("));
    expect(harnessIndex).toBeLessThan(harness.indexOf(".whenReady()"));
    expect(harness.split(configuration)).toHaveLength(2);
    const admission = harness.indexOf(
      "const primitiveAdmission = primitiveProbe?.admitOrExit(app);",
    );
    if (admission !== -1) {
      expect(harness.indexOf(productionImport)).toBeGreaterThan(admission);
    }
  });
});
