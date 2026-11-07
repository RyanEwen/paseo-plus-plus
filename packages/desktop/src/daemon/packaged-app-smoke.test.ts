import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The harness lives in e2e/, which the desktop unit suite excludes, so its tests live here.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const require = createRequire(import.meta.url);
const {
  createIsolatedHomeEnv,
  prepareTerminalHookSmokeCommand,
  getCliShimScript,
  hasTerminalSmokeMarker,
  smokeColdCliDaemonStart,
} = require(join(packageRoot, "e2e", "packaged-app-smoke.js"));

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

describe("packaged app smoke harness", () => {
  it("retains cold CLI worker logs and the original failure before removing its profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-cold-cli-evidence-"));
    const appPath = join(root, "Paseo.app");
    const resources =
      process.platform === "darwin"
        ? join(appPath, "Contents", "Resources")
        : join(appPath, "resources");
    const bin = join(resources, "bin");
    const artifactDir = join(root, "artifacts");
    const program = join(bin, "cold-start.cjs");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      program,
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const home = process.argv[process.argv.indexOf("--home") + 1];',
        'fs.writeFileSync(__filename + ".home", home);',
        'fs.writeFileSync(path.join(home, "daemon.log"), "fixture daemon detail\\n");',
        'fs.writeFileSync(path.join(home, "terminal-worker.log"), "fixture worker detail\\n");',
        'process.stderr.write("fixture startup failure\\n");',
        "process.exitCode = 17;",
      ].join("\n"),
    );
    const windows = process.platform === "win32";
    const shim = join(bin, windows ? "paseo.cmd" : "paseo");
    writeExecutable(
      shim,
      windows
        ? '@echo off\r\nnode "%~dp0cold-start.cjs" %*\r\nexit /b %errorlevel%\r\n'
        : '#!/bin/sh\nexec node "$(dirname "$0")/cold-start.cjs" "$@"\n',
    );
    try {
      await expect(smokeColdCliDaemonStart({ appPath, artifactDir })).rejects.toThrow(
        "fixture startup failure",
      );
      expect(existsSync(join(artifactDir, "terminal-worker.log"))).toBe(true);
      expect(readFileSync(join(artifactDir, "terminal-worker.log"), "utf8")).toBe(
        "fixture worker detail\n",
      );
      expect(readFileSync(join(artifactDir, "daemon.log"), "utf8")).toBe("fixture daemon detail\n");
      expect(readFileSync(join(artifactDir, "failure.txt"), "utf8")).toContain(
        "fixture startup failure",
      );
      expect(existsSync(readFileSync(program + ".home", "utf8"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a successful bundled hook rather than its echoed terminal command", () => {
    const marker = "paseo-packaged-terminal-smoke-test";
    expect(hasTerminalSmokeMarker([`cwd>echo ${marker}`], marker)).toBe(false);
    expect(hasTerminalSmokeMarker([`  ${marker}  `], marker)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "paseo-hook-smoke-"));
    try {
      const windows = process.platform === "win32";
      const hook = join(root, windows ? "hook with spaces.cmd" : "hook with spaces.sh");
      const shell = windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
      const command = prepareTerminalHookSmokeCommand(root, marker);
      for (const status of [0, 17]) {
        writeExecutable(
          hook,
          windows ? `@echo off\r\nexit /b ${status}\r\n` : `#!/bin/sh\nexit ${status}\n`,
        );
        const result = spawnSync(shell, windows ? ["/d", "/c", command] : ["-c", command], {
          encoding: "utf8",
          windowsVerbatimArguments: windows,
          cwd: root,
          env: { ...process.env, PASEO_HOOK_CLI: hook },
        });
        expect(result.status, result.stderr).toBe(status);
        expect(hasTerminalSmokeMarker(result.stdout.split(/\r?\n/), marker)).toBe(status === 0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "preserves terminal input and JSON mode through Electron Windows argv parsing",
    () => {
      const root = mkdtempSync(join(tmpdir(), "paseo-electron-cli-"));
      try {
        const electron = require("electron") as string;
        const entry = join(root, "argv.cjs");
        const shim = join(root, "cli shim.cmd");
        writeFileSync(
          entry,
          'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");',
        );
        writeFileSync(
          shim,
          `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${electron}" "${entry}" %*\r\nexit /b %errorlevel%\r\n`,
        );
        const command = prepareTerminalHookSmokeCommand(root, "paseo-terminal-fixture");
        const args = ["terminal", "send-keys", "terminal-test", command, "Enter", "--json"];
        const result = spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/c", getCliShimScript(shim, args)],
          {
            encoding: "utf8",
            windowsVerbatimArguments: true,
            cwd: root,
          },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(args);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("creates an isolated Windows profile with existing Electron appData folders", () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-smoke-profile-"));
    try {
      const env = createIsolatedHomeEnv(home, "win32");
      expect(env.HOME).toBe(home);
      expect(env.USERPROFILE).toBe(home);
      expect(env.APPDATA).toBe(join(home, "AppData", "Roaming"));
      expect(env.LOCALAPPDATA).toBe(join(home, "AppData", "Local"));
      expect(existsSync(env.APPDATA)).toBe(true);
      expect(existsSync(env.LOCALAPPDATA)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
