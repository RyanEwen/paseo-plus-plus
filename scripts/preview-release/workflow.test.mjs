import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { jobBlocks } from "../test-support/workflow-jobs.mjs";
import { requireDiagnosticOnly } from "./windows-powershell-probe/index.mjs";

const repoRoot = new URL("../../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);

/** Reads a job's own `if:` and `needs:` so a test can evaluate them as GitHub would. */
function jobGate(lines) {
  const condition = lines.find((line) => /^ {4}if: /.test(line))?.replace(/^ {4}if: /, "");
  const needs = lines.find((line) => /^ {4}needs: /.test(line))?.replace(/^ {4}needs: /, "") ?? "";
  return {
    condition: condition?.replace(/^\$\{\{\s*/, "").replace(/\s*\}\}$/, "") ?? "true",
    needs: needs
      .replace(/[[\]\s]/g, "")
      .split(",")
      .filter(Boolean),
  };
}

test("the PowerShell probe input decides exactly which workflow jobs run", () => {
  const source = readFileSync(new URL(".github/workflows/preview-release.yml", repoRoot), "utf8");
  const jobs = jobBlocks(source);
  const gates = new Map([...jobs].map(([name, lines]) => [name, jobGate(lines)]));

  /** Which jobs run: its own condition holds and every job it needs ran, the implicit success(). */
  const runningJobs = (inputs) => {
    const running = new Set();
    const github = { repository: "RyanEwen/paseo-plus-plus" };
    for (const [name, gate] of gates) {
      const ownCondition = runInNewContext(gate.condition, { inputs, github });
      if (ownCondition && gate.needs.every((need) => running.has(need))) running.add(name);
    }
    return [...running].sort();
  };

  const releaseJobs = ["android", "daemon", "desktop", "release", "source"];
  for (const inputs of [
    {},
    { windows_powershell_probe: false },
    { windows_powershell_probe: false, publish: true, release_kind: "latest" },
  ]) {
    assert.deepEqual(runningJobs(inputs), releaseJobs, JSON.stringify(inputs));
  }
  assert.deepEqual(
    runningJobs({ windows_powershell_probe: false, verify_daemon_updates_only: true }),
    ["daemon", "source"],
  );
  // Every release job stays excluded whatever else is set; the probe's own guard then fails it.
  for (const inputs of [
    {},
    { publish: true },
    { release_kind: "bridge" },
    { release_kind: "latest" },
    { verify_daemon_updates_only: true },
    { publish: true, release_kind: "latest", verify_daemon_updates_only: true },
  ]) {
    assert.deepEqual(
      runningJobs({ ...inputs, windows_powershell_probe: true }),
      ["windows-powershell-probe"],
      JSON.stringify(inputs),
    );
  }
});

test("the PowerShell probe mode cannot reach release jobs, credentials or release artifacts", () => {
  const source = readFileSync(new URL(".github/workflows/preview-release.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(
    trigger,
    /windows_powershell_probe:\n\s+description: "Diagnostic only[^\n]*\n\s+default: false\n\s+type: boolean/,
  );
  const jobs = jobBlocks(source);
  const probe = jobs.get("windows-powershell-probe").join("\n");
  assert.match(probe, /runs-on: \$\{\{ matrix\.runner \}\}/);
  for (const leg of [
    /runner: windows-11-arm\n\s+arch: arm64\n\s+cold_first: jscript/,
    /runner: windows-2025\n\s+arch: x64\n\s+cold_first: jscript/,
    /runner: windows-2025\n\s+arch: x64\n\s+cold_first: query/,
    /runner: windows-2025\n\s+arch: x64\n\s+cold_first: startup/,
  ]) {
    assert.match(probe, leg);
  }
  assert.match(probe, /timeout-minutes: 30/);
  assert.match(probe, /architecture: \$\{\{ matrix\.arch \}\}/);
  assert.match(probe, /permissions:\n\s+contents: read\n/);
  assert.match(probe, /persist-credentials: false/);
  assert.doesNotMatch(probe, /^\s+needs:/m);
  assert.doesNotMatch(probe, /secrets\.|vars\.|GH_TOKEN|GITHUB_TOKEN|AZURE|KEYSTORE/);
  assert.doesNotMatch(probe, /npm-retry|build:desktop|publish\.mjs|gh release|printenv|env \|/);

  // The release job collects preview-*, and this artifact must never match that pattern.
  assert.match(jobs.get("release").join("\n"), /pattern: preview-\*/);
  assert.match(
    probe,
    /name: windows-powershell-probe-\$\{\{ matrix\.arch \}\}-\$\{\{ matrix\.cold_first \}\}/,
  );
  for (const job of ["source", "desktop", "android", "daemon", "release"]) {
    assert.doesNotMatch(jobs.get(job).join("\n"), /windows-powershell-probe/, job);
  }
  assert.match(source, /group: fork-preview-release\n/);
  assert.match(source, /^name: Fork Preview Release$/m);
});

test("the PowerShell probe fails closed on any mix with a release option", () => {
  const diagnostic = {
    probe: "true",
    publish: "false",
    releaseKind: "preview",
    verifyDaemon: "false",
  };
  assert.doesNotThrow(() => requireDiagnosticOnly(diagnostic));
  for (const invalid of [
    { probe: "false" },
    { probe: undefined },
    { publish: "true" },
    { publish: undefined },
    { releaseKind: "bridge" },
    { releaseKind: "latest" },
    { releaseKind: undefined },
    { verifyDaemon: "true" },
    { verifyDaemon: undefined },
  ]) {
    assert.throws(
      () => requireDiagnosticOnly({ ...diagnostic, ...invalid }),
      JSON.stringify(invalid),
    );
  }
});

test("preview releases build one checked commit and require every approved platform before publishing", () => {
  const source = readFileSync(new URL(".github/workflows/preview-release.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /workflow_dispatch:/);
  assert.doesNotMatch(trigger, /push:|pull_request:/);
  // COMPAT(forkRepositoryRename): remove this legacy repository assertion after 2027-04-14.
  assert.match(source, /github\.repository == 'RyanEwen\/paseo'/);
  assert.match(source, /github\.repository == 'RyanEwen\/paseo-plus-plus'/);
  assert.match(source, /run: node scripts\/preview-release\/source\.mjs/);
  const jobs = jobBlocks(source);
  for (const job of ["desktop", "android", "release"]) {
    assert.match(
      jobs.get(job).join("\n"),
      /if: \$\{\{ !inputs\.verify_daemon_updates_only && !inputs\.windows_powershell_probe \}\}/,
    );
  }
  const daemonJob = jobs.get("daemon").join("\n");
  assert.match(daemonJob, /daemon\.mjs --smoke/);
  assert.match(daemonJob, /if: inputs\.verify_daemon_updates_only[\s\S]*daemon-update\.mjs/);
  assert.match(source, /ref: \$\{\{ needs\.source\.outputs\.commit \}\}/);
  assert.match(source, /needs: \[source, desktop, android, daemon\]/);
  assert.match(
    source,
    /gradlew :app:assembleRelease --no-daemon --max-workers=1 -Dorg\.gradle\.parallel=false/,
  );
  assert.match(source, /writePreviewBundlePlan[\s\S]*android-bundle\.mjs[\s\S]*assembleRelease/);
  assert.match(source, /-PpaseoPreparedAndroidBundle=true/);
  assert.match(source, /unzip -p "\$apk" assets\/index\.android\.bundle \| sha256sum/);
  for (const runner of ["windows-2025", "windows-11-arm", "ubuntu-24.04", "ubuntu-24.04-arm"]) {
    assert.ok(source.includes(`runner: ${runner}`), `missing ${runner}`);
  }
  assert.doesNotMatch(source, /macos|eas build|npm publish|contents: write[\s\S]*contents: write/);
  assert.match(
    source,
    /release_kind:[\s\S]*default: preview[\s\S]*- preview[ \t]*\n[ \t]+- bridge[ \t]*\n[ \t]+- latest/,
  );
  assert.match(
    jobs.get("source").join("\n"),
    /run: node scripts\/preview-release\/publication-policy\.mjs/,
  );
  assert.match(
    jobs.get("release").join("\n"),
    /PASEO_PREVIEW_RELEASE_KIND: \$\{\{ inputs\.release_kind \}\}/,
  );
});

/** A pinned published bridge and later source, without GitHub access or publication. */

test("fork main keeps upstream deployment and automatic Nix writes disabled", () => {
  const website = readFileSync(new URL(".github/workflows/deploy-website.yml", repoRoot), "utf8");
  const nix = readFileSync(new URL(".github/workflows/nix-update-hash.yml", repoRoot), "utf8");
  assert.match(website, /if: \$\{\{ github\.repository == 'getpaseo\/paseo' &&/);
  assert.match(website, /!github\.event\.release\.prerelease && !github\.event\.release\.draft/);
  assert.match(nix, /update-hash:\n    if: github\.repository == 'getpaseo\/paseo'/);
  const ci = readFileSync(ciWorkflowPath, "utf8");
  // COMPAT(forkIntegrationRename): drop ryan/dev and ryan/preview after 2027-04-14.
  assert.match(ci, /^  push:\n    branches: \[main, ryan\/dev, ryan\/preview\]$/m);
});
