import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { providerHistoryCommand, runHistoryPreview, runHistoryMigrationPrompt } from "./history.js";
import { selectDaemonTarget } from "../../utils/daemon-target.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "paseo-preview-cli-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("local preview of a derived provider returns safe JSON without initializing either home", async () => {
  const result = await runHistoryPreview(
    "claude-work",
    {
      daemonTarget: { kind: "instance", home },
      family: "claude",
      providerHome: path.join(home, "absent"),
    },
    new Command(),
  );
  expect(result.data.provider).toBe("claude-work");
  expect(result.data.family).toBe("claude");
  expect(result.data.applySupported).toBe(false);
  expect(result.data.sessions).toEqual([]);
  expect(await readdir(home)).toEqual([]);
});

test("remote targets and unsupported provider families cannot be interpreted as local storage", async () => {
  await expect(
    runHistoryPreview(
      "codex",
      {
        daemonTarget: { kind: "endpoint", host: "ssh://example.test" },
        providerHome: home,
      },
      new Command(),
    ),
  ).rejects.toThrow("local --home");
  await expect(
    runHistoryPreview(
      "opencode",
      {
        daemonTarget: { kind: "instance", home },
        providerHome: home,
      },
      new Command(),
    ),
  ).rejects.toThrow("supports codex and claude");
  expect(() => selectDaemonTarget({ host: "ssh://example.test" }, {}, true)).toThrow();
  expect(await readdir(home)).toEqual([]);
});

test("relative paths and incorrect base-family combinations fail before inspection", async () => {
  await expect(
    runHistoryPreview(
      "codex",
      {
        daemonTarget: { kind: "instance", home },
        providerHome: "relative",
      },
      new Command(),
    ),
  ).rejects.toThrow("absolute local home");
  await expect(
    runHistoryPreview(
      "codex",
      {
        daemonTarget: { kind: "instance", home },
        providerHome: home,
        family: "claude",
      },
      new Command(),
    ),
  ).rejects.toThrow("does not match");
  expect(await readdir(home)).toEqual([]);
});

test("configured destination remains a local read-only preview when its config is absent", async () => {
  const result = await runHistoryPreview(
    "codex",
    {
      daemonTarget: { kind: "instance", home },
      providerHome: path.join(home, "absent-source"),
      destinationProvider: "codex-work",
    },
    new Command(),
  );
  expect(result.data.destination).toMatchObject({ provider: "codex-work", admission: "conflict" });
  expect(result.data.applySupported).toBe(false);
  expect(await readdir(home)).toEqual([]);
});

test("migration prompt replaces destructive commands without exposing transcript/config/title fields", async () => {
  expect(providerHistoryCommand().commands.map((command) => command.name())).toEqual([
    "preview",
    "migration-prompt",
  ]);
  const source = path.join(home, "source");
  await mkdir(path.join(source, "sessions"), { recursive: true });
  await mkdir(path.join(home, "agents"));
  await writeFile(
    path.join(source, "sessions", "rollout.jsonl"),
    JSON.stringify({
      type: "session_meta",
      payload: { id: "candidate", transcript: "private-transcript" },
    }) + "\n",
  );
  await writeFile(
    path.join(home, "agents", "a.json"),
    JSON.stringify({
      id: "agent-a",
      provider: "codex",
      cwd: home,
      title: "private-title",
      labels: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      lastStatus: "closed",
      persistence: { provider: "codex", sessionId: "candidate" },
      config: { systemPrompt: "private-system", mcpServers: { privateToken: "private-token" } },
      providerHistory: {
        origin: "created",
        registration: "registered",
        sessionId: "candidate",
        storage: { kind: "unknown" },
      },
    }),
  );
  const result = await runHistoryMigrationPrompt(
    "codex",
    {
      daemonTarget: { kind: "instance", home },
      providerHome: source,
      destinationHome: path.join(home, "uncreated"),
    },
    new Command(),
  );
  expect(result.data.context.sessions[0]).toMatchObject({
    sessionId: "candidate",
    provenance: "created",
    disposition: "needs-classification",
  });
  expect(result.data.context).toMatchObject({
    inventoryPerformed: true,
    inventoryPartial: true,
    destinationVerified: false,
    mutationApproved: false,
  });
  expect(JSON.stringify(result.data)).not.toMatch(
    /private-transcript|private-title|private-system|private-token/,
  );
  expect(await readdir(home)).not.toContain("uncreated");
});

test("migration prompt handles Claude and keeps proposed paths safely quoted without creating homes", async () => {
  const destination = path.join(home, "```<untrusted>");
  const result = await runHistoryMigrationPrompt(
    "claude-work",
    {
      daemonTarget: { kind: "instance", home },
      family: "claude",
      providerHome: path.join(home, "absent"),
      destinationHome: destination,
    },
    new Command(),
  );
  expect(result.data.prompt.split("```")).toHaveLength(3);
  expect(result.data.prompt).not.toContain("<untrusted>");
  expect(result.data.context.destination?.home).toBe(destination);
  expect(await readdir(home)).toEqual([]);
});

test("migration prompt reports bounded and omitted native inventory", async () => {
  const source = path.join(home, "source");
  await mkdir(path.join(source, "sessions"), { recursive: true });
  for (let i = 0; i < 60; i++)
    await writeFile(
      path.join(source, "sessions", `${i}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id: `native-${i}` } }) + "\n",
    );
  const result = await runHistoryMigrationPrompt(
    "codex",
    {
      daemonTarget: { kind: "instance", home },
      providerHome: source,
      destinationHome: path.join(home, "uncreated"),
    },
    new Command(),
  );
  expect(result.data.context.sessions).toHaveLength(50);
  expect(result.data.context.omitted.sessions).toBe(10);
  expect(result.data.context.sessions.every((session) => session.disposition === "preserve")).toBe(
    true,
  );
});

test("migration prompt refuses remote, malformed and wrong-family routes without mutations", async () => {
  const options = {
    daemonTarget: { kind: "instance" as const, home },
    providerHome: path.join(home, "absent"),
    destinationHome: path.join(home, "destination"),
  };
  await expect(
    runHistoryMigrationPrompt(
      "codex",
      { ...options, daemonTarget: { kind: "endpoint", host: "ssh://example.test" } },
      new Command(),
    ),
  ).rejects.toThrow("local --home");
  await expect(
    runHistoryMigrationPrompt("codex", { ...options, destinationHome: "relative" }, new Command()),
  ).rejects.toThrow("bounded absolute paths");
  await expect(
    runHistoryMigrationPrompt("claude", { ...options, destinationSqliteHome: home }, new Command()),
  ).rejects.toThrow("only to Codex");
  expect(await readdir(home)).toEqual([]);
});
