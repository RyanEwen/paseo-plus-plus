import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDaemonDistribution } from "@getpaseo/server/daemon-control";
import { describe, expect, it } from "vitest";
import { resolveDesktopDistribution, resolveDesktopUpdateChannel } from "./distribution.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

it("agrees with the bundled daemon defaults for preview builds", () => {
  const metadata = { paseoPreview: true };
  const root = mkdtempSync(join(tmpdir(), "paseo-desktop-defaults-"));
  try {
    const asar = join(root, "app.asar");
    const server = join(asar, "node_modules", "@getpaseo", "server");
    mkdirSync(server, { recursive: true });
    writeFileSync(
      join(asar, "package.json"),
      JSON.stringify({ name: "paseo-plus-plus", ...metadata }),
    );
    const daemon = resolveDaemonDistribution(
      pathToFileURL(join(server, "dist", "daemon-distribution.js")).href,
    );
    const desktop = resolveDesktopDistribution(metadata);
    expect(`127.0.0.1:${daemon.defaultPort}`).toBe(desktop.daemonListen);
    expect(daemon.defaultHome).toBe(`~/${desktop.daemonHomeName}`);
    expect(daemon.cliPackage).toBe("@getpaseo/cli");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop distribution", () => {
  it("keeps fork settings and the local daemon isolated while pinning preview updates", () => {
    expect(resolveDesktopDistribution({ paseoPreview: true })).toEqual({
      isPreview: true,
      appName: "Paseo++",
      windowsAppUserModelId: "sh.paseo.plusplus.desktop",
      desktopName: "paseo-plus-plus.desktop",
      daemonHomeName: ".paseo-plus-plus-desktop",
      daemonListen: "127.0.0.1:6790",
    });
    expect(resolveDesktopUpdateChannel({ isPreview: true, releaseChannel: "stable" })).toEqual({
      allowPrerelease: true,
      channel: "preview",
    });
    expect(resolveDesktopUpdateChannel({ isPreview: true, releaseChannel: "beta" })).toEqual({
      allowPrerelease: true,
      channel: "preview",
    });
    expect(resolveDesktopUpdateChannel({ isPreview: false, releaseChannel: "stable" })).toEqual({
      allowPrerelease: false,
      channel: "latest",
    });
    expect(resolveDesktopUpdateChannel({ isPreview: false, releaseChannel: "beta" })).toEqual({
      allowPrerelease: true,
      channel: "beta",
    });
  });
});

// The packaged identity must agree with the existing NSIS registration.
describe("Windows packaged notification identity", () => {
  it("uses the installer AUMID for the fork notification process", () => {
    expect(resolveDesktopDistribution({ paseoPreview: true })).toMatchObject({
      windowsAppUserModelId: "sh.paseo.plusplus.desktop",
    });
    const config = readFileSync(join(packageRoot, "electron-builder.preview.yml"), "utf8");
    const installerAppId = config.match(/^appId:\s*(\S+)\s*$/m)?.[1];
    expect(installerAppId).toBe(
      resolveDesktopDistribution({ paseoPreview: true }).windowsAppUserModelId,
    );
  });
});
