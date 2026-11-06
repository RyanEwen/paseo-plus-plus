import { afterEach, beforeEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewProviderHistory, sqliteHistoryReader } from "./preview.js";
import { parseStoredAgentRecord, type StoredAgentRecord } from "../agent-storage.js";
let directory: string;
let paseoHome: string;
let providerHome: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "paseo-history-fixture-"));
  paseoHome = path.join(directory, "paseo");
  providerHome = path.join(directory, "provider");
  await mkdir(path.join(paseoHome, "agents"), { recursive: true });
  await mkdir(providerHome);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function json(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value) + "\n");
}
async function record(
  id: string,
  origin?: "created" | "imported",
  provider = "codex",
): Promise<void> {
  const stored: StoredAgentRecord = {
    id: `agent-${id}`,
    provider,
    cwd: directory,
    labels: {},
    lastStatus: "closed",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    persistence: { provider, sessionId: id },
    providerHistory: origin
      ? { origin, registration: "registered", sessionId: id, storage: { kind: "unknown" } }
      : undefined,
  };
  await json(path.join(paseoHome, "agents", `${id}.json`), stored);
}
async function rollout(id: string, parent?: string): Promise<void> {
  await json(path.join(providerHome, "sessions", `${id}.jsonl`), {
    type: "session_meta",
    payload: { id, parent_thread_id: parent },
  });
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(file));
    else if (entry.isFile()) result[file] = (await readFile(file)).toString("base64");
  }
  return result;
}

// The real WAL remains open throughout both snapshots. SQLite must never open this source.
test("inventories actual descendants from headers and a WAL database without changing source bytes", async () => {
  await record("created", "created");
  await record("imported", "imported");
  await record("legacy");
  await record("missing");
  for (const id of ["created", "imported", "legacy", "native", "db-child"]) await rollout(id);
  await rollout("header-child", "created");
  await rollout("import-child", "imported");
  const db = new DatabaseSync(path.join(providerHome, "state_5.sqlite"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT); INSERT INTO thread_spawn_edges VALUES('created','db-child')",
    );
    const before = await snapshot(directory);
    const report = await previewProviderHistory({
      paseoHome,
      provider: "codex",
      family: "codex",
      providerHome,
    });
    expect(report.applySupported).toBe(false);
    expect(
      report.sessions.map(({ id, provenance, disposition }) => ({ id, provenance, disposition })),
    ).toEqual([
      { id: "created", provenance: "created", disposition: "needs-classification" },
      { id: "db-child", provenance: "descendant", disposition: "needs-classification" },
      { id: "header-child", provenance: "descendant", disposition: "needs-classification" },
      { id: "import-child", provenance: "native-only", disposition: "preserve" },
      { id: "imported", provenance: "imported", disposition: "preserve" },
      { id: "legacy", provenance: "legacy", disposition: "needs-classification" },
      { id: "native", provenance: "native-only", disposition: "preserve" },
    ]);
    expect(report.missingSessionIds).toEqual(["missing"]);
    expect(report.databases.map((entry) => entry.schema)).toEqual(["recognized-inventory"]);
    expect(report.issues.map((issue) => issue.code)).toEqual([
      "sqlite-roots-and-migration-schema-unverified",
      "native-use-and-exclusive-ownership-unverified",
    ]);
    expect(await snapshot(directory)).toEqual(before);
    expect(
      (
        await previewProviderHistory({
          paseoHome,
          provider: "codex",
          family: "codex",
          providerHome,
        })
      ).digest,
    ).toBe(report.digest);
  } finally {
    db.close();
  }
});

test("missing homes, database and WAL are never created", async () => {
  const absent = path.join(directory, "absent");
  const before = await snapshot(directory);
  const report = await previewProviderHistory({
    paseoHome: absent,
    provider: "codex",
    family: "codex",
    providerHome: absent,
  });
  expect(report.sessions).toEqual([]);
  expect(report.databases).toEqual([]);
  expect(report.issues.map((issue) => issue.code)).toContain("database-missing-or-linked");
  expect(await snapshot(directory)).toEqual(before);
  expect(await readdir(directory)).toEqual(["paseo", "provider"]);
});

test("unsupported SQLite schemas remain untouched and cannot imply apply support", async () => {
  const db = new DatabaseSync(path.join(providerHome, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE unknown_schema(secret TEXT); INSERT INTO unknown_schema VALUES ('TRANSCRIPT_SECRET')",
  );
  db.close();
  const before = await snapshot(directory);
  const report = await previewProviderHistory({
    paseoHome,
    provider: "codex",
    family: "codex",
    providerHome,
  });
  expect(report.databases.map((entry) => entry.schema)).toEqual(["unsupported"]);
  expect(report.applySupported).toBe(false);
  expect(JSON.stringify(report)).not.toContain("TRANSCRIPT_SECRET");
  expect(await snapshot(directory)).toEqual(before);
});

test("symlinked rollout trees and WAL files are reported without following or repairing them", async () => {
  const external = path.join(directory, "external");
  await mkdir(external);
  await json(path.join(external, "native.jsonl"), {
    type: "session_meta",
    payload: { id: "native" },
  });
  await symlink(external, path.join(providerHome, "sessions"));
  const report = await previewProviderHistory({
    paseoHome,
    provider: "codex",
    family: "codex",
    providerHome,
  });
  expect(report.sessions).toEqual([]);
  expect(report.issues).toContainEqual({
    code: "symlink-not-followed",
    path: path.join(providerHome, "sessions"),
  });
  expect(await readdir(external)).toEqual(["native.jsonl"]);
});

test("Claude roots are exact sessions, while child support files and malformed headers need classification", async () => {
  await record("claude-owned", "created", "claude-work");
  await record("claude-imported", "imported", "claude-work");
  for (const id of ["claude-owned", "claude-imported", "native"]) {
    await json(path.join(providerHome, "projects", "project", `${id}.jsonl`), {
      sessionId: id,
      message: { content: "TRANSCRIPT_SECRET" },
    });
  }
  await json(
    path.join(
      providerHome,
      "projects",
      "project",
      "claude-owned",
      "subagents",
      "agent-child.jsonl",
    ),
    { sessionId: "claude-owned" },
  );
  await writeFile(
    path.join(providerHome, "projects", "project", "malformed.jsonl"),
    JSON.stringify({ type: "queue-operation" }) +
      "\n" +
      JSON.stringify({ sessionId: "leading-queue", message: { content: "TRANSCRIPT_SECRET" } }) +
      "\n",
  );
  const before = await snapshot(directory);
  const report = await previewProviderHistory({
    paseoHome,
    provider: "claude-work",
    family: "claude",
    providerHome,
  });
  expect(report.sessions.map(({ id, provenance }) => ({ id, provenance }))).toEqual([
    { id: "claude-imported", provenance: "imported" },
    { id: "claude-owned", provenance: "created" },
    { id: "native", provenance: "native-only" },
  ]);
  expect(report.issues.map((issue) => issue.code)).toEqual([
    "claude-support-file-needs-classification",
    "unrecognized-session-header",
    "native-use-and-exclusive-ownership-unverified",
  ]);
  expect(JSON.stringify(report)).not.toContain("TRANSCRIPT_SECRET");
  expect(await snapshot(directory)).toEqual(before);
});

test("a source WAL change invalidates the snapshot and discards its ancestry edges", async () => {
  await record("created", "created");
  await rollout("created");
  await rollout("db-child");
  const db = new DatabaseSync(path.join(providerHome, "state_5.sqlite"));
  let afterWriter: Record<string, string> = {};
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT); INSERT INTO thread_spawn_edges VALUES('created','db-child')",
    );
    const report = await previewProviderHistory(
      { paseoHome, provider: "codex", family: "codex", providerHome },
      {
        async inspect(file) {
          const copied = await sqliteHistoryReader.inspect(file);
          db.exec("INSERT INTO thread_spawn_edges VALUES('created','later-child')");
          afterWriter = await snapshot(directory);
          return copied;
        },
      },
    );
    expect(report.databases[0].snapshot).toBe("invalid");
    expect(report.sessions.find((entry) => entry.id === "db-child")?.provenance).toBe(
      "native-only",
    );
    expect(report.issues.map((issue) => issue.code)).toContain("database-changed-during-preview");
    expect(await snapshot(directory)).toEqual(afterWriter);
  } finally {
    db.close();
  }
});

test("conflicting roots and multiple-parent boundaries cannot seed descendants", async () => {
  const ids = ["duplicate", "wrong-store", "wrong-id", "pending", "valid"];
  for (const id of ids) {
    await record(id, "created");
    await rollout(id);
    await rollout(`${id}-child`, id);
  }
  await json(path.join(providerHome, "archived_sessions", "duplicate-copy.jsonl"), {
    type: "session_meta",
    payload: { id: "duplicate" },
  });
  for (const id of ["wrong-store", "wrong-id", "pending"]) {
    const file = path.join(paseoHome, "agents", `${id}.json`);
    const stored = parseStoredAgentRecord(JSON.parse(await readFile(file, "utf8")));
    if (!stored.providerHistory) throw new Error("Expected fixture binding");
    if (id === "wrong-store")
      stored.providerHistory.storage = {
        kind: "unverified",
        provider: "codex",
        home: path.join(directory, "another-home"),
      };
    if (id === "wrong-id") stored.providerHistory.sessionId = "another-id";
    if (id === "pending") stored.providerHistory.registration = "intent";
    await json(file, stored);
  }
  await rollout("mixed-child", "valid");
  await rollout("mixed-grandchild", "mixed-child");
  const db = new DatabaseSync(path.join(providerHome, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT); INSERT INTO thread_spawn_edges VALUES('native-parent','mixed-child')",
  );
  db.close();
  const report = await previewProviderHistory({
    paseoHome,
    provider: "codex",
    family: "codex",
    providerHome,
  });
  expect(
    report.sessions.filter((entry) => entry.provenance === "descendant").map((entry) => entry.id),
  ).toEqual(["valid-child"]);
  const conflicts = report.sessions.filter((entry) => entry.provenance === "conflict");
  expect(conflicts.map((entry) => entry.id).sort()).toEqual(
    [
      "duplicate-child",
      "duplicate",
      "mixed-child",
      "mixed-grandchild",
      "pending-child",
      "pending",
      "wrong-id-child",
      "wrong-id",
      "wrong-store-child",
      "wrong-store",
      "duplicate",
    ].sort(),
  );
  expect(conflicts.every((entry) => entry.disposition === "preserve")).toBe(true);
});

test.each(["unsupported", "runtime-unavailable"] as const)(
  "%s database inspection cannot contribute ancestry edges",
  async (schema) => {
    await record("created", "created");
    await rollout("created");
    await rollout("db-child");
    const db = new DatabaseSync(path.join(providerHome, "state_5.sqlite"));
    db.exec("CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT)");
    db.close();
    const before = await snapshot(directory);
    const report = await previewProviderHistory(
      { paseoHome, provider: "codex", family: "codex", providerHome },
      {
        async inspect() {
          return { schema, issue: null, edges: [{ parent: "created", child: "db-child" }] };
        },
      },
    );
    expect(report.sessions.find((entry) => entry.id === "db-child")?.provenance).toBe(
      "native-only",
    );
    expect(report.databases[0].schema).toBe(schema);
    expect(await snapshot(directory)).toEqual(before);
  },
);

test("another provider profile's imported session is a preservation boundary in a shared home", async () => {
  await record("selected-root", "created", "codex-work");
  await record("other-profile", "imported", "codex-personal");
  await rollout("selected-root");
  await rollout("other-profile", "selected-root");
  await rollout("other-child", "other-profile");
  const before = await snapshot(directory);
  const report = await previewProviderHistory({
    paseoHome,
    provider: "codex-work",
    family: "codex",
    providerHome,
  });
  expect(report.sessions.filter((entry) => entry.provenance === "descendant")).toEqual([]);
  expect(
    report.sessions
      .filter((entry) => entry.provenance === "conflict")
      .map((entry) => ({ id: entry.id, disposition: entry.disposition })),
  ).toEqual([
    { id: "other-child", disposition: "preserve" },
    { id: "other-profile", disposition: "preserve" },
  ]);
  expect(report.missingSessionIds).toEqual([]);
  expect(await snapshot(directory)).toEqual(before);
});

test("the same session ID referenced by another profile cannot seed descendants", async () => {
  await record("shared-id", "created", "codex-work");
  await rollout("shared-id");
  await rollout("shared-child", "shared-id");
  const original = parseStoredAgentRecord(
    JSON.parse(await readFile(path.join(paseoHome, "agents", "shared-id.json"), "utf8")),
  );
  await json(path.join(paseoHome, "agents", "foreign-reference.json"), {
    ...original,
    id: "another-agent",
    provider: "codex-personal",
    persistence: { provider: "codex-personal", sessionId: "shared-id" },
    providerHistory: {
      origin: "imported",
      registration: "registered",
      sessionId: "shared-id",
      storage: { kind: "unknown" },
    },
  });
  const before = await snapshot(directory);
  const report = await previewProviderHistory({
    paseoHome,
    provider: "codex-work",
    family: "codex",
    providerHome,
  });
  expect(
    report.sessions.map((entry) => ({
      id: entry.id,
      provenance: entry.provenance,
      disposition: entry.disposition,
    })),
  ).toEqual([
    { id: "shared-child", provenance: "conflict", disposition: "preserve" },
    { id: "shared-id", provenance: "conflict", disposition: "preserve" },
  ]);
  expect(await snapshot(directory)).toEqual(before);
});

test.each(["codex-work", "codex-personal"])(
  "an unresolved import intent under %s blocks ancestry without becoming an owned root",
  async (provider) => {
    await record("created-root", "created", "codex-work");
    await rollout("created-root");
    await rollout("imported-child", "created-root");
    await rollout("nested-child", "imported-child");
    await json(path.join(paseoHome, "agents", "failed-import.json"), {
      id: "failed-import",
      provider,
      cwd: directory,
      workspaceId: "fixture-workspace",
      labels: {},
      lastStatus: "closed",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      providerHistory: {
        origin: "imported",
        registration: "intent",
        sessionId: "imported-child",
        storage: { kind: "unknown" },
      },
    });
    const before = await snapshot(directory);
    const report = await previewProviderHistory({
      paseoHome,
      provider: "codex-work",
      family: "codex",
      providerHome,
    });
    expect(
      report.sessions.map(({ id, provenance, disposition }) => ({ id, provenance, disposition })),
    ).toEqual([
      { id: "created-root", provenance: "created", disposition: "needs-classification" },
      { id: "imported-child", provenance: "conflict", disposition: "preserve" },
      { id: "nested-child", provenance: "conflict", disposition: "preserve" },
    ]);
    expect(await snapshot(directory)).toEqual(before);
  },
);

test("conflicting bound and persisted IDs are both barriers and neither seeds descendants", async () => {
  await record("persisted", "created");
  const file = path.join(paseoHome, "agents", "persisted.json");
  const stored = parseStoredAgentRecord(JSON.parse(await readFile(file, "utf8")));
  if (!stored.providerHistory) throw new Error("Expected fixture binding");
  stored.providerHistory.sessionId = "bound";
  await json(file, stored);
  await rollout("bound");
  await rollout("bound-child", "bound");
  await rollout("persisted");
  await rollout("persisted-child", "persisted");
  const before = await snapshot(directory);
  const report = await previewProviderHistory({
    paseoHome,
    provider: "codex",
    family: "codex",
    providerHome,
  });
  expect(
    report.sessions.map(({ id, provenance, disposition }) => ({ id, provenance, disposition })),
  ).toEqual([
    { id: "bound-child", provenance: "conflict", disposition: "preserve" },
    { id: "bound", provenance: "conflict", disposition: "preserve" },
    { id: "persisted-child", provenance: "conflict", disposition: "preserve" },
    { id: "persisted", provenance: "conflict", disposition: "preserve" },
  ]);
  expect(await snapshot(directory)).toEqual(before);
});

async function configuredDestination(home: string, sqliteHome = home): Promise<void> {
  await json(path.join(paseoHome, "config.json"), {
    agents: {
      providers: {
        codex: {
          history: { mode: "configured" },
          env: { CODEX_HOME: home },
          options: { sqlite_home: sqliteHome },
        },
        "codex-work": { extends: "codex", label: "Work" },
      },
    },
  });
}

test("configured destination uses inherited canonical config and actual disposable SQLite without mutations", async () => {
  await record("created", "created");
  await rollout("created");
  const home = path.join(directory, "destination");
  const sql = path.join(directory, "destination-db");
  await mkdir(home);
  await mkdir(sql);
  await configuredDestination(home, sql);
  await json(path.join(home, "sessions", "existing.jsonl"), {
    type: "session_meta",
    payload: { id: "existing" },
  });
  const db = new DatabaseSync(path.join(sql, "state_5.sqlite"));
  db.exec("CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT)");
  db.close();
  const before = await snapshot(directory);
  const report = await previewProviderHistory({
    paseoHome,
    provider: "codex",
    family: "codex",
    providerHome,
    destinationProvider: "codex-work",
  });
  expect(report.destination).toMatchObject({
    provider: "codex-work",
    admission: "configured",
    storage: { kind: "configured-home", home, sqliteHome: sql },
    sourceOverlap: false,
    sessionCount: 1,
    collidingSessionIds: [],
  });
  expect(report.destination?.issues.map((issue) => issue.code)).toContain(
    "destination-launch-environment-and-managed-policy-unverified",
  );
  expect(report.applySupported).toBe(false);
  expect(await snapshot(directory)).toEqual(before);
});

test("destination reports overlapping source and colliding native IDs instead of implying migration admission", async () => {
  await rollout("same");
  await configuredDestination(providerHome);
  const report = await previewProviderHistory({
    paseoHome,
    provider: "codex",
    family: "codex",
    providerHome,
    destinationProvider: "codex-work",
  });
  expect(report.destination).toMatchObject({
    admission: "conflict",
    sourceOverlap: true,
    collidingSessionIds: ["same"],
  });
  const other = path.join(directory, "other");
  await mkdir(other);
  await configuredDestination(other);
  await json(path.join(other, "sessions", "same.jsonl"), {
    type: "session_meta",
    payload: { id: "same" },
  });
  const separate = await previewProviderHistory({
    paseoHome,
    provider: "codex",
    family: "codex",
    providerHome,
    destinationProvider: "codex-work",
  });
  expect(separate.destination).toMatchObject({
    admission: "conflict",
    sourceOverlap: false,
    collidingSessionIds: ["same"],
  });
});

test("missing or linked destination configuration/root remains unchanged and unadmitted", async () => {
  const absent = path.join(directory, "missing-destination");
  await configuredDestination(absent);
  const before = await snapshot(directory);
  const args = {
    paseoHome,
    provider: "codex",
    family: "codex" as const,
    providerHome,
    destinationProvider: "codex-work",
  };
  expect((await previewProviderHistory(args)).destination).toMatchObject({ admission: "conflict" });
  expect(await snapshot(directory)).toEqual(before);
  await rm(path.join(paseoHome, "config.json"));
  await symlink(path.join(directory, "absent-config"), path.join(paseoHome, "config.json"));
  const linked = await previewProviderHistory(args);
  expect(linked.destination?.issues.map((issue) => issue.code)).toContain(
    "destination-config-missing-or-linked",
  );
  expect(linked.destination?.storage).toBeUndefined();
  expect(await readdir(directory)).not.toContain("missing-destination");
});

test("bound SQLite mismatch is a root/descendant preservation barrier", async () => {
  await record("bound", "created");
  const file = path.join(paseoHome, "agents", "bound.json");
  const stored = parseStoredAgentRecord(JSON.parse(await readFile(file, "utf8")));
  if (!stored) throw new Error("Missing fixture record");
  stored.providerHistory = {
    origin: "created",
    registration: "registered",
    sessionId: "bound",
    storage: {
      kind: "configured-home",
      provider: "codex",
      home: providerHome,
      sqliteHome: path.join(directory, "different-db"),
    },
  };
  await json(file, stored);
  await rollout("bound");
  await rollout("child", "bound");
  const report = await previewProviderHistory({
    paseoHome,
    provider: "codex",
    family: "codex",
    providerHome,
  });
  expect(
    report.sessions.map(({ id, provenance, disposition }) => ({ id, provenance, disposition })),
  ).toEqual([
    { id: "bound", provenance: "conflict", disposition: "preserve" },
    { id: "child", provenance: "conflict", disposition: "preserve" },
  ]);
});

test("configured Claude preview preserves raw selector semantics and pending fresh barriers", async () => {
  for (const id of ["bound", "pending", "foreign"]) {
    await record(id, "created", "claude-work");
    const file = path.join(paseoHome, "agents", `${id}.json`);
    const stored = JSON.parse(await readFile(file, "utf8"));
    stored.providerHistory.storage =
      id === "foreign"
        ? {
            kind: "configured-home",
            provider: "codex",
            home: providerHome,
            sqliteHome: providerHome,
          }
        : { kind: "configured-home", provider: "claude", home: providerHome + "/" };
    if (id === "pending") stored.claudeFreshRewind = { operationId: "pending-reset" };
    await json(file, stored);
    await json(path.join(providerHome, "projects", "project", `${id}.jsonl`), { sessionId: id });
  }
  const before = await snapshot(directory);
  const report = await previewProviderHistory({
    paseoHome,
    provider: "claude-work",
    family: "claude",
    providerHome,
  });
  expect(report.sessions.map(({ id, provenance }) => ({ id, provenance }))).toEqual([
    { id: "bound", provenance: "created" },
    { id: "foreign", provenance: "conflict" },
    { id: "pending", provenance: "conflict" },
  ]);
  expect(await snapshot(directory)).toEqual(before);
});
