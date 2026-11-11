import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { preparePreviewBuild } from "./prepare.mjs";
import { requireFromElectronBuilder } from "./packager.mjs";

const { getConfig, validateConfiguration } = requireFromElectronBuilder(
  "app-builder-lib/out/util/config/config.js",
);
const { LinuxTargetHelper } = requireFromElectronBuilder(
  "app-builder-lib/out/targets/LinuxTargetHelper.js",
);

test("prepares a Windows ARM64 build with inherited packaging and required Azure signing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-preview-prepare-"));
  try {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        version: "0.11.0-beta.5",
        workspaces: [
          "packages/desktop",
          "packages/app",
          "packages/server",
          "packages/cli",
          "packages/client",
        ],
      }),
    );
    for (const name of ["desktop", "app", "server", "cli", "client"]) {
      const folder = path.join(root, "packages", name);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, "package.json"),
        JSON.stringify({
          name: `@getpaseo/${name}`,
          version: "0.11.0-beta.5",
          private: name === "desktop" || name === "app",
          dependencies: name === "client" ? {} : { "@getpaseo/client": "0.11.0-beta.5" },
        }),
      );
    }
    // Version stamping runs the checkout's own upstream sync script.
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(
      new URL("../sync-workspace-versions.mjs", import.meta.url),
      path.join(root, "scripts/sync-workspace-versions.mjs"),
    );
    const desktop = path.join(root, "packages/desktop");
    for (const name of ["electron-builder.yml", "electron-builder.preview.yml"]) {
      copyFileSync(
        new URL(`../../packages/desktop/${name}`, import.meta.url),
        path.join(desktop, name),
      );
    }
    const input = {
      root,
      buildNumber: 12,
      commit: "a".repeat(40),
      platform: "win32",
      arch: "arm64",
    };
    await assert.rejects(preparePreviewBuild({ ...input, signingEnv: {} }), /Missing Azure/);
    assert.equal(
      JSON.parse(readFileSync(path.join(desktop, "package.json"))).version,
      "0.11.0-beta.5",
    );
    await preparePreviewBuild({
      ...input,
      signingEnv: {
        PASEO_AZURE_PUBLISHER_NAME: "Example Publisher",
        PASEO_AZURE_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net",
        PASEO_AZURE_CERTIFICATE_PROFILE: "example",
        PASEO_AZURE_SIGNING_ACCOUNT: "example",
      },
    });
    const config = await getConfig(desktop, "electron-builder.preview.local.yml", null);
    validateConfiguration(config);
    assert.equal(config.appId, "sh.paseo.plusplus.desktop");
    assert.equal(config.productName, "Paseo++");
    assert.equal(config.publish.owner, "RyanEwen");
    assert.equal(config.publish.channel, "preview");
    assert.deepEqual(config.protocols, [
      { name: "Paseo++ agent link", schemes: ["paseo-plus-plus"] },
    ]);
    assert.deepEqual(config.appImage.executableArgs, ["--class=paseo-plus-plus"]);
    assert.equal(config.linux.executableName, "paseo-plus-plus");
    assert.equal(config.extraMetadata.desktopName, "paseo-plus-plus.desktop");
    assert.deepEqual(config.linux.executableArgs, ["--class=paseo-plus-plus"]);
    assert.equal(config.linux.desktop.entry.StartupWMClass, "paseo-plus-plus");
    const desktopEntry = await new LinuxTargetHelper({
      executableName: config.linux.executableName,
      platformSpecificBuildOptions: config.linux,
      config,
      fileAssociations: [],
      info: { metadata: config.extraMetadata },
      appInfo: {
        productName: config.productName,
        sanitizedProductName: config.productName,
        description: "Preview desktop",
      },
    }).computeDesktopEntry(config.linux);
    assert.match(desktopEntry, /^Name=Paseo\+\+$/m);
    assert.match(
      desktopEntry,
      /^Exec="\/opt\/Paseo\+\+\/paseo-plus-plus" --class=paseo-plus-plus %U$/m,
    );
    assert.match(desktopEntry, /^StartupWMClass=paseo-plus-plus$/m);
    assert.equal(config.extraMetadata.paseoPreview, true);
    assert.equal(config.buildVersion, "0.11.0.12");
    for (const name of ["desktop", "app", "server", "cli", "client"]) {
      const pkg = JSON.parse(readFileSync(path.join(root, "packages", name, "package.json")));
      assert.equal(pkg.version, "0.11.0-preview.12");
      if (name !== "client") {
        assert.equal(pkg.dependencies["@getpaseo/client"], pkg.private ? "*" : pkg.version);
      }
    }
    assert.equal(
      JSON.parse(readFileSync(path.join(root, "package.json"))).version,
      "0.11.0-preview.12",
    );
    assert.equal(config.forceCodeSigning, true);
    assert.deepEqual(config.win.target, [
      { target: "nsis", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ]);
    assert.ok(config.files.length > 0);
    assert.equal(
      JSON.parse(readFileSync(path.join(root, "packages/app/package.json"))).version,
      "0.11.0-preview.12",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
