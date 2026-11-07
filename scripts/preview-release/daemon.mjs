import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../is-main-module.mjs";
import { smokeRunningDaemon } from "./daemon-smoke.mjs";
import { stageDaemonRuntime } from "./runtime.mjs";
import assert from "node:assert/strict";
import { stampCheckoutVersion, writePreviewRelease } from "./metadata.mjs";
import { loadNativePtyModules } from "../native-pty.mjs";
import { runNpm } from "./npm.mjs";

/**
 * Run the checkout's daemon trace and return the traced paths, one per output line.
 * `root` is the checkout whose scripts/trace-daemon.mjs is run, with `root` as the working directory.
 */
export function readTracedDaemonFiles(root) {
  return execFileSync(process.execPath, [path.join(root, "scripts/trace-daemon.mjs")], {
    cwd: root,
    encoding: "utf8",
    // The traced closure lists thousands of paths; Node's default 1 MiB stdout buffer is too small.
    maxBuffer: 64 * 1024 * 1024,
  })
    .trim()
    .split("\n");
}

/** Stage the existing traced runtime as a dependency-free npm tarball for this native host. */
export function buildDaemonPackage({ root, output, release }) {
  const staging = path.join(output, "package");
  mkdirSync(staging, { recursive: true });
  try {
    const files = readTracedDaemonFiles(root);
    stageDaemonRuntime({ root, output: path.join(staging, "runtime"), files });
    const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    cpSync(path.join(root, "LICENSE"), path.join(staging, "LICENSE"));
    writeFileSync(path.join(staging, "runtime/package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(path.join(staging, "bin"));
    const launcher = path.join(staging, "bin/paseo-plus-plus");
    writeFileSync(
      launcher,
      '#!/usr/bin/env node\nimport "../runtime/packages/cli/dist/index.js";\n',
    );
    chmodSync(launcher, 0o755);
    writeFileSync(
      path.join(staging, "package.json"),
      JSON.stringify(
        {
          name: "@ryanewen/paseo-daemon",
          license: rootManifest.license,
          version: release.version,
          type: "module",
          bin: { "paseo-plus-plus": "bin/paseo-plus-plus" },
          engines: { node: ">=22" },
          os: [process.platform],
          cpu: [process.arch],
          paseoPreview: release,
        },
        null,
        2,
      ),
    );
    const filename = `paseo-daemon-${release.version}-${process.platform}-${process.arch}.tgz`;
    execFileSync("tar", ["-czf", path.join(output, filename), "-C", output, "package"], {
      stdio: "inherit",
    });
    writePreviewRelease(path.join(output, "preview-release.json"), release);
    return path.join(output, filename);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Import a compiled server module from the installed package's runtime. */
function importServerModule(serverRoot, relativePath) {
  return import(pathToFileURL(path.join(serverRoot, "dist/server/server", relativePath)).href);
}

/** The installed package must keep the fork's npm update identity and command name. */
async function assertDistributionIdentity({ manifest, serverRoot }) {
  const npmModule = await importServerModule(serverRoot, "session/daemon/npm-global-cli.js");
  assert.equal(
    npmModule.PASEO_CLI_PACKAGE,
    manifest.name,
    "Installed daemon lost its fork update identity",
  );
  assert.deepEqual(manifest.bin, { "paseo-plus-plus": "bin/paseo-plus-plus" });
}

/** The fork daemon defaults to its own home and port, and explicit overrides still win. */
async function assertDefaultHomeAndListen({ packageRoot, serverRoot }) {
  const control = await importServerModule(serverRoot, "daemon-instance.js");
  assert.equal(control.daemonDistribution.defaultHome, "~/.paseo-plus-plus");
  assert.equal(control.daemonDistribution.defaultPort, 6791);

  const persisted = await importServerModule(serverRoot, "persisted-config.js");
  const freshHome = mkdtempSync(path.join(tmpdir(), "paseo-plus-plus-defaults-"));
  try {
    const defaults = persisted.readPersistedConfig(freshHome, { defaultsIfMissing: true });
    assert.equal(defaults.daemon.listen, "127.0.0.1:6791");
  } finally {
    rmSync(freshHome, { recursive: true, force: true });
  }

  const defaultHome = path.join(homedir(), ".paseo-plus-plus");
  assert.equal(control.resolvePaseoHome({}), defaultHome);
  assert.equal(control.resolvePaseoHome({ PASEO_HOME: packageRoot }), packageRoot);

  const configModule = await importServerModule(serverRoot, "config.js");
  assert.equal(
    configModule.resolveConfigFromPersisted(defaultHome, {}, { env: {} }).listen,
    "127.0.0.1:6791",
  );
  assert.equal(
    configModule.resolveConfigFromPersisted(
      defaultHome,
      { daemon: { listen: "127.0.0.1:7009" } },
      { env: {} },
    ).listen,
    "127.0.0.1:7009",
  );
  assert.equal(
    configModule.resolveConfigFromPersisted(
      defaultHome,
      {},
      { env: { PASEO_LISTEN: "127.0.0.1:7010" } },
    ).listen,
    "127.0.0.1:7010",
  );
}

/** The bundled server matches the package version and loads its native PTY and speech runtimes. */
function assertNativeRuntime({ manifest, serverRoot }) {
  const serverManifest = JSON.parse(readFileSync(path.join(serverRoot, "package.json"), "utf8"));
  assert.equal(
    serverManifest.version,
    manifest.version,
    "Installed daemon version does not match its distribution",
  );
  const require = createRequire(path.join(serverRoot, "package.json"));
  loadNativePtyModules(require);
  const speech = require("sherpa-onnx-node");
  assert.equal(
    typeof speech.OfflineRecognizer,
    "function",
    "Installed speech runtime is unavailable",
  );
}

/** The installed CLI reports the package version and documents the fork's command and home. */
function assertCliEntrypoint({ manifest, packageRoot }) {
  const cli = path.join(packageRoot, "bin/paseo-plus-plus");
  const version = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim();
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /Usage: paseo-plus-plus/);
  assert.match(help, /~\/.paseo-plus-plus/);
  assert.equal(version, manifest.version, `Installed CLI reports unexpected version: ${version}`);
  return version;
}

/** Check the installed distribution identity and native modules, without starting a host daemon. */
export async function smokeDaemonPackage(packageRoot) {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const serverRoot = path.join(packageRoot, "runtime/packages/server");

  await assertDistributionIdentity({ manifest, serverRoot });
  await assertDefaultHomeAndListen({ packageRoot, serverRoot });
  assertNativeRuntime({ manifest, serverRoot });
  const version = assertCliEntrypoint({ manifest, packageRoot });
  process.stdout.write(
    `Installed fork daemon ${version}: distribution and native modules verified\n`,
  );
}

if (isMainModule(import.meta.url) && process.argv[2] === "--smoke") {
  const packageRoot = path.resolve(process.argv[3]);
  await smokeDaemonPackage(packageRoot);
  await smokeRunningDaemon({ packageRoot });
} else if (isMainModule(import.meta.url)) {
  const root = process.cwd();
  const release = JSON.parse(readFileSync("preview-release.json", "utf8"));
  stampCheckoutVersion({ root, version: release.version });
  runNpm(["run", "build:server"], { stdio: "inherit" });
  runNpm(["run", "build:daemon-web-ui"], {
    stdio: "inherit",
    // Expo derives native metadata even for a browser export. Use the same preview identity
    // as the app jobs after syncing the workspace manifests to the preview version.
    env: {
      ...process.env,
      APP_VARIANT: "development",
      PASEO_PREVIEW_BUILD: "1",
      PASEO_PREVIEW_BUILD_NUMBER: String(release.buildNumber),
    },
  });
  buildDaemonPackage({ root, output: path.resolve("preview-daemon"), release });
}
