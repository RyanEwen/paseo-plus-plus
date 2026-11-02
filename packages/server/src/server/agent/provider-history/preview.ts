import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseStoredAgentRecord, type StoredAgentRecord } from "../agent-storage.js";
import { readPersistedConfig } from "../../persisted-config.js";
import {
  ProviderOverridesSchema,
  resolveConfiguredCodexHistoryProfile,
} from "../provider-launch-config.js";
import { historyRootsOverlap, resolveConfiguredCodexHistory } from "../providers/codex/history.js";
import { HistoryStorageConflictError, type ConfiguredHistoryStorage } from "./binding.js";

const MAX_FILES = 10_000;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const CodexHeader = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: Identifier,
    parent_thread_id: Identifier.nullable().optional(),
    forked_from_id: Identifier.nullable().optional(),
  }),
});
const ClaudeHeader = z.object({ sessionId: Identifier });
const Edge = z.object({ parent_thread_id: Identifier, child_thread_id: Identifier });

export interface HistoryPreviewInput {
  paseoHome: string;
  provider: string;
  family: "codex" | "claude";
  providerHome: string;
  sqliteHome?: string;
  destinationProvider?: string;
}

interface PreviewIssue {
  code: string;
  path: string;
}
interface SessionFile {
  id: string;
  source: string;
  bytes: number;
  sha256: string;
  parents: string[];
}
interface SessionCandidate extends SessionFile {
  agentIds: string[];
  provenance: "created" | "imported" | "legacy" | "descendant" | "native-only" | "conflict";
  disposition: "preserve" | "needs-classification";
}
interface ArtifactInventory {
  source: string;
  bytes: number;
  sha256: string;
}
interface DatabaseInventory {
  source: string;
  sha256: string;
  walSha256: string | null;
  schema: "recognized-inventory" | "unsupported" | "runtime-unavailable";
  snapshot: "unverified" | "invalid";
}
interface UnresolvedHistoryIntent {
  agentId: string;
  origin: "created" | "imported" | "legacy";
  requestedSessionId: string | null;
  workspaceId: string | null;
  configFields: string[];
}
export interface ProviderHistoryPreview {
  provider: string;
  family: HistoryPreviewInput["family"];
  providerHome: string;
  digest: string;
  applySupported: false;
  sessions: SessionCandidate[];
  missingSessionIds: string[];
  unresolvedAgentIds: string[];
  unresolvedIntents: UnresolvedHistoryIntent[];
  databases: DatabaseInventory[];
  artifacts: ArtifactInventory[];
  issues: PreviewIssue[];
  destination?: {
    provider: string;
    admission: "configured" | "conflict" | "unavailable";
    storage?: ConfiguredHistoryStorage;
    sourceOverlap: boolean;
    collidingSessionIds: string[];
    inventoryDigest?: string;
    sessionCount?: number;
    issues: PreviewIssue[];
  };
}
interface Inventory {
  issues: PreviewIssue[];
  visited: number;
}
interface InventoryDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (file: string, options: { readOnly: boolean }) => InventoryDatabase;
}
const SqliteModuleSchema = z.object({
  DatabaseSync: z.custom<SqliteModule["DatabaseSync"]>((value) => typeof value === "function"),
});
const Column = z.object({ name: z.string() });

interface DatabaseSnapshot {
  database: DatabaseInventory;
  edges: SpawnEdge[];
}

interface SpawnEdge {
  parent: string;
  child: string;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function hash(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

// Never traverse a symlink, including one above an otherwise ordinary file.
async function regularPath(file: string, inventory: Inventory): Promise<boolean> {
  const absolute = path.resolve(file);
  const relative = path.relative(path.parse(absolute).root, absolute);
  let current = path.parse(absolute).root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        inventory.issues.push({ code: "symlink-not-followed", path: current });
        return false;
      }
    } catch (error) {
      if (!missing(error)) throw error;
      return false;
    }
  }
  return true;
}

async function files(root: string, inventory: Inventory, depth = 0): Promise<string[]> {
  if (!(await regularPath(root, inventory))) return [];
  if (depth > 6) {
    inventory.issues.push({ code: "scan-depth-limit", path: root });
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    inventory.visited++;
    if (inventory.visited > MAX_FILES) {
      inventory.issues.push({ code: "scan-entry-limit", path: root });
      break;
    }
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) inventory.issues.push({ code: "symlink-not-followed", path: file });
    else if (entry.isDirectory()) found.push(...(await files(file, inventory, depth + 1)));
    else if (entry.isFile()) found.push(file);
  }
  return found;
}

async function readRecords(home: string, inventory: Inventory): Promise<StoredAgentRecord[]> {
  const records: StoredAgentRecord[] = [];
  const paths = await files(path.join(home, "agents"), inventory);
  for (const file of paths.filter((entry) => entry.endsWith(".json"))) {
    if ((await lstat(file)).size > MAX_RECORD_BYTES) {
      inventory.issues.push({ code: "agent-record-size-limit", path: file });
      continue;
    }
    try {
      records.push(parseStoredAgentRecord(JSON.parse(await readFile(file, "utf8"))));
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      inventory.issues.push({ code: "invalid-agent-record", path: file });
    }
  }
  return records;
}

async function header(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
  } finally {
    await handle.close();
  }
}

interface SessionMetadataInput {
  family: HistoryPreviewInput["family"];
  file: string;
  raw: unknown;
  inventory: Inventory;
}
interface SessionMetadata {
  id: string;
  parents: string[];
}

function sessionMetadata(input: SessionMetadataInput): SessionMetadata | null {
  const { family, file, raw, inventory } = input;
  if (family === "codex") {
    const parsed = CodexHeader.parse(raw).payload;
    const parents = [parsed.parent_thread_id, parsed.forked_from_id].filter(
      (id): id is string => typeof id === "string",
    );
    return { id: parsed.id, parents };
  }
  const id = ClaudeHeader.parse(raw).sessionId;
  // Child/workflow transcripts may carry the parent's sessionId. They are support
  // files, not another root or proof of exclusive child ownership.
  if (path.basename(file) !== `${id}.jsonl`) {
    inventory.issues.push({ code: "claude-support-file-needs-classification", path: file });
    return null;
  }
  return { id, parents: [] };
}

async function sessionFile(input: Omit<SessionMetadataInput, "raw">): Promise<SessionFile | null> {
  const { family, file, inventory } = input;
  try {
    const before = await lstat(file);
    if (before.size > MAX_DATABASE_BYTES) {
      inventory.issues.push({ code: "session-size-limit", path: file });
      return null;
    }
    const raw: unknown = JSON.parse(await header(file));
    const metadata = sessionMetadata({ family, file, raw, inventory });
    if (!metadata) return null;
    const sha256 = await hash(file);
    const after = await lstat(file);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      inventory.issues.push({ code: "changed-during-preview", path: file });
    }
    return { ...metadata, source: file, bytes: before.size, sha256 };
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
    inventory.issues.push({ code: "unrecognized-session-header", path: file });
    return null;
  }
}

async function readSessions(
  input: HistoryPreviewInput,
  inventory: Inventory,
): Promise<SessionFile[]> {
  const roots = input.family === "codex" ? ["sessions", "archived_sessions"] : ["projects"];
  const sessions: SessionFile[] = [];
  for (const root of roots) {
    const paths = await files(path.join(input.providerHome, root), inventory);
    for (const file of paths.filter((entry) => entry.endsWith(".jsonl"))) {
      const parsed = await sessionFile({ family: input.family, file, inventory });
      if (parsed) sessions.push(parsed);
    }
  }
  return sessions;
}

interface DatabaseInspection {
  schema: DatabaseInventory["schema"];
  edges: SpawnEdge[];
  issue: string | null;
}

export interface HistoryPreviewDatabaseReader {
  inspect(snapshotPath: string): Promise<DatabaseInspection>;
}

async function copyDatabase(
  source: string,
  target: string,
  inventory: Inventory,
): Promise<Map<string, string> | null> {
  const snapshots = new Map<string, string>();
  for (const suffix of ["", "-wal"]) {
    const file = source + suffix;
    const issueCount = inventory.issues.length;
    if (!(await regularPath(file, inventory))) {
      if (inventory.issues.length !== issueCount) return null;
      continue;
    }
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_DATABASE_BYTES) {
      inventory.issues.push({ code: "database-size-or-type-limit", path: file });
      return null;
    }
    await copyFile(file, target + suffix);
    const digest = await hash(target + suffix);
    snapshots.set(suffix, digest);
    if (digest !== (await hash(file))) {
      inventory.issues.push({ code: "database-changed-during-preview", path: source });
      return null;
    }
  }
  return snapshots;
}

function readEdges(db: InventoryDatabase): DatabaseInspection {
  const columns = db.prepare("PRAGMA table_info(thread_spawn_edges)").all();
  const names = new Set(columns.map((column) => Column.parse(column).name));
  const recognized = names.has("parent_thread_id") && names.has("child_thread_id");
  if (!recognized) return { schema: "unsupported", edges: [], issue: null };
  const rows = db
    .prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges LIMIT 10001")
    .all();
  if (rows.length > MAX_FILES) {
    return { schema: "unsupported", edges: [], issue: "database-row-limit" };
  }
  const edges = rows.map((row) => {
    const edge = Edge.parse(row);
    return { parent: edge.parent_thread_id, child: edge.child_thread_id };
  });
  return { schema: "recognized-inventory", edges, issue: null };
}

async function inspectDatabase(target: string): Promise<DatabaseInspection> {
  // The repository's Node 20 declarations predate the optional runtime builtin.
  const specifier: string = "node:sqlite";
  let module: unknown;
  try {
    module = await import(specifier);
  } catch (error) {
    const unavailable =
      error instanceof Error && "code" in error && error.code === "ERR_UNKNOWN_BUILTIN_MODULE";
    const code = unavailable ? "sqlite-runtime-unavailable" : "database-unreadable-or-unsupported";
    return { schema: "runtime-unavailable", edges: [], issue: code };
  }
  try {
    const { DatabaseSync } = SqliteModuleSchema.parse(module);
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      return readEdges(db);
    } finally {
      db.close();
    }
  } catch {
    // SQLite errors can include arbitrary schema text; expose a fixed code only.
    return { schema: "unsupported", edges: [], issue: "database-unreadable-or-unsupported" };
  }
}

export const sqliteHistoryReader: HistoryPreviewDatabaseReader = { inspect: inspectDatabase };

async function verifyDatabaseSnapshot(
  source: string,
  snapshots: Map<string, string>,
  inventory: Inventory,
): Promise<boolean> {
  let unchanged = true;
  for (const suffix of ["", "-wal"]) {
    let current: string | undefined;
    try {
      current = await hash(source + suffix);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (current !== snapshots.get(suffix)) {
      inventory.issues.push({ code: "database-changed-during-preview", path: source });
      unchanged = false;
    }
  }
  return unchanged;
}

// SQLite can create SHM files even when opened read-only. Open only a disposable copy,
// including WAL, and reject a source that changes while it is being copied. No source locks.
async function database(
  source: string,
  inventory: Inventory,
  reader: HistoryPreviewDatabaseReader,
): Promise<DatabaseSnapshot | null> {
  if (!(await regularPath(source, inventory))) {
    inventory.issues.push({ code: "database-missing-or-linked", path: source });
    return null;
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "paseo-history-preview-"));
  try {
    const target = path.join(temporary, "state.sqlite");
    const snapshots = await copyDatabase(source, target, inventory);
    if (!snapshots) return null;
    const inspection = await reader.inspect(target);
    if (inspection.issue) inventory.issues.push({ code: inspection.issue, path: source });
    if (inspection.schema === "unsupported")
      inventory.issues.push({ code: "database-schema-unsupported", path: source });
    const unchanged = await verifyDatabaseSnapshot(source, snapshots, inventory);
    const usable = unchanged && inspection.schema === "recognized-inventory";
    const edges = usable ? inspection.edges : [];
    return {
      database: {
        source,
        sha256: await hash(target),
        walSha256: snapshots.get("-wal") ?? null,
        schema: inspection.schema,
        snapshot: unchanged ? "unverified" : "invalid",
      },
      edges,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

interface SessionClassificationInput {
  family: HistoryPreviewInput["family"];
  file: SessionFile;
  owners: StoredAgentRecord[];
  copies: number;
  provider: string;
  sqliteHome: string;
}

function classifySession(input: SessionClassificationInput): SessionCandidate {
  const { file, owners, copies, provider } = input;
  let provenance: SessionCandidate["provenance"] = owners.length ? "legacy" : "native-only";
  const origins = new Set(owners.map((record) => record.providerHistory?.origin));
  if (origins.size === 1 && origins.has("created")) provenance = "created";
  if (origins.size === 1 && origins.has("imported")) provenance = "imported";
  const identityConflict = owners.some((record) => {
    const binding = record.providerHistory;
    return (
      record.claudeFreshRewind !== undefined ||
      (binding !== undefined &&
        (binding.registration !== "registered" ||
          binding.sessionId !== file.id ||
          record.persistence?.sessionId !== file.id))
    );
  });
  const storageConflict = owners.some((record) => {
    const storage = record.providerHistory?.storage;
    return (
      storage !== undefined &&
      storage.kind !== "unknown" &&
      (storage.provider !== input.family ||
        !file.source.startsWith(
          path.resolve(
            storage.provider === "claude" ? storage.home.normalize("NFC") : storage.home,
          ) + path.sep,
        ) ||
        (storage.kind === "configured-home" &&
          storage.provider === "codex" &&
          storage.sqliteHome !== input.sqliteHome))
    );
  });
  const anotherProviderReferences = owners.some((record) => record.provider !== provider);
  const ambiguous =
    owners.length > 1 || copies > 1 || origins.size > 1 || anotherProviderReferences;
  if (identityConflict || storageConflict || ambiguous) provenance = "conflict";
  return {
    ...file,
    agentIds: owners.map((record) => record.id).sort(),
    provenance,
    disposition: "preserve",
  };
}

function classifyDescendants(listed: SessionCandidate[], relations: SpawnEdge[]): void {
  const parents = new Map<string, Set<string>>();
  for (const edge of relations) {
    const references = parents.get(edge.child) ?? new Set<string>();
    references.add(edge.parent);
    parents.set(edge.child, references);
  }
  const validated = new Set<string>();
  for (const file of listed) {
    const references = parents.get(file.id) ?? new Set<string>();
    if (references.size > 1) file.provenance = "conflict";
    if (references.size === 0 && file.provenance === "created") validated.add(file.id);
  }
  expandDescendants(listed, parents, validated);
  for (const file of listed) {
    if (file.provenance === "created" && !validated.has(file.id)) file.provenance = "conflict";
  }
  propagateConflicts(listed, parents);
  for (const file of listed) {
    const candidate = ["created", "legacy", "descendant"].includes(file.provenance);
    file.disposition = candidate ? "needs-classification" : "preserve";
  }
}

function expandDescendants(
  listed: SessionCandidate[],
  parents: Map<string, Set<string>>,
  validated: Set<string>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of listed) {
      const eligible = file.provenance === "created" || file.provenance === "native-only";
      const references = parents.get(file.id);
      if (!eligible || validated.has(file.id) || !references || references.size !== 1) continue;
      if (![...references].every((parent) => validated.has(parent))) continue;
      validated.add(file.id);
      if (file.provenance === "native-only") file.provenance = "descendant";
      changed = true;
    }
  }
}

function propagateConflicts(listed: SessionCandidate[], parents: Map<string, Set<string>>): void {
  const blocked = new Set(
    listed.filter((file) => file.provenance === "conflict").map((file) => file.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of listed) {
      if (file.provenance !== "native-only") continue;
      const references = parents.get(file.id) ?? new Set<string>();
      if (![...references].some((parent) => blocked.has(parent))) continue;
      file.provenance = "conflict";
      blocked.add(file.id);
      changed = true;
    }
  }
}

interface CandidateScope {
  family: HistoryPreviewInput["family"];
  sessions: SessionFile[];
  records: StoredAgentRecord[];
  edges: SpawnEdge[];
  provider: string;
  sqliteHome: string;
}

function candidates(input: CandidateScope): SessionCandidate[] {
  const { sessions, records, edges, provider } = input;
  const byId = new Map<string, StoredAgentRecord[]>();
  for (const record of records) {
    // An unresolved import request is a preservation reference even before the
    // provider returns persistence. Conflicting old/current bindings protect both IDs.
    const ids = new Set([record.persistence?.sessionId, record.providerHistory?.sessionId]);
    for (const id of ids) {
      if (id) byId.set(id, [...(byId.get(id) ?? []), record]);
    }
  }
  const counts = new Map<string, number>();
  for (const file of sessions) counts.set(file.id, (counts.get(file.id) ?? 0) + 1);
  const listed = sessions.map((file) =>
    classifySession({
      file,
      family: input.family,
      owners: byId.get(file.id) ?? [],
      copies: counts.get(file.id) ?? 0,
      provider,
      sqliteHome: input.sqliteHome,
    }),
  );
  const relations = [...edges];
  for (const file of sessions) {
    for (const parent of file.parents) relations.push({ parent, child: file.id });
  }
  classifyDescendants(listed, relations);
  return listed;
}

async function artifacts(
  input: HistoryPreviewInput,
  inventory: Inventory,
): Promise<ArtifactInventory[]> {
  const paths = [
    path.join(input.providerHome, "history.jsonl"),
    path.join(input.providerHome, "session_index.jsonl"),
  ];
  if (input.family === "codex") {
    const sqlite = input.sqliteHome ?? input.providerHome;
    paths.push(
      path.join(sqlite, "thread_history_1.sqlite"),
      path.join(sqlite, "thread_history_1.sqlite-wal"),
    );
  }
  const found: ArtifactInventory[] = [];
  for (const source of paths) {
    if (!(await regularPath(source, inventory))) continue;
    const before = await lstat(source);
    if (!before.isFile() || before.size > MAX_DATABASE_BYTES) {
      inventory.issues.push({ code: "artifact-size-or-type-limit", path: source });
      continue;
    }
    const sha256 = await hash(source);
    const after = await lstat(source);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      inventory.issues.push({ code: "changed-during-preview", path: source });
    }
    found.push({ source, bytes: before.size, sha256 });
  }
  return found;
}

export async function previewProviderHistory(
  input: HistoryPreviewInput,
  reader: HistoryPreviewDatabaseReader = sqliteHistoryReader,
): Promise<ProviderHistoryPreview> {
  if (
    !path.isAbsolute(input.paseoHome) ||
    !path.isAbsolute(input.providerHome) ||
    (input.sqliteHome !== undefined && !path.isAbsolute(input.sqliteHome))
  ) {
    throw new Error("History preview requires absolute local home paths");
  }
  const inventory: Inventory = { issues: [], visited: 0 };
  const allRecords = await readRecords(input.paseoHome, inventory);
  const records = allRecords.filter((record) => record.provider === input.provider);
  const sessions = await readSessions(input, inventory);
  const databases: DatabaseInventory[] = [];
  const edges: SpawnEdge[] = [];
  if (input.family === "codex") {
    const source = path.join(input.sqliteHome ?? input.providerHome, "state_5.sqlite");
    const snapshot = await database(source, inventory, reader);
    if (snapshot) {
      databases.push(snapshot.database);
      edges.push(...snapshot.edges);
    }
    inventory.issues.push({
      code: "sqlite-roots-and-migration-schema-unverified",
      path: input.sqliteHome ?? input.providerHome,
    });
  }
  // A preview cannot exclude current Desktop/CLI writers or prove exclusive ownership.
  inventory.issues.push({
    code: "native-use-and-exclusive-ownership-unverified",
    path: input.providerHome,
  });
  const listed = candidates({
    family: input.family,
    sessions,
    records: allRecords,
    edges,
    provider: input.provider,
    sqliteHome: path.resolve(input.sqliteHome ?? input.providerHome),
  });
  const artifactInventory = await artifacts(input, inventory);
  const found = new Set(sessions.map((session) => session.id));
  const missingSessionIds = records.flatMap((record) => {
    const id = record.persistence?.sessionId;
    return id && !found.has(id) ? [id] : [];
  });
  const unresolvedIntents: UnresolvedHistoryIntent[] = [];
  for (const record of records) {
    const binding = record.providerHistory;
    if (binding?.registration !== "intent") continue;
    unresolvedIntents.push({
      agentId: record.id,
      origin: binding.origin,
      requestedSessionId: binding.sessionId,
      workspaceId: record.workspaceId ?? null,
      configFields: Object.keys(record.config ?? {}).sort(),
    });
  }
  const report = {
    provider: input.provider,
    family: input.family,
    providerHome: input.providerHome,
    applySupported: false as const,
    sessions: listed,
    missingSessionIds: [...new Set(missingSessionIds)].sort(),
    unresolvedAgentIds: records
      .filter((record) => !record.persistence?.sessionId)
      .map((record) => record.id)
      .sort(),
    unresolvedIntents,
    databases,
    artifacts: artifactInventory,
    issues: inventory.issues,
  };
  const destination = input.destinationProvider
    ? await previewDestination(input, listed, reader)
    : undefined;
  const complete = destination ? { ...report, destination } : report;
  const digest = createHash("sha256").update(JSON.stringify(complete)).digest("hex");
  return { ...complete, digest };
}

async function previewDestination(
  input: HistoryPreviewInput,
  source: SessionCandidate[],
  reader: HistoryPreviewDatabaseReader,
): Promise<NonNullable<ProviderHistoryPreview["destination"]>> {
  const provider = input.destinationProvider!;
  const result: NonNullable<ProviderHistoryPreview["destination"]> = {
    provider,
    admission: "unavailable",
    sourceOverlap: false,
    collidingSessionIds: [],
    issues: [],
  };
  try {
    if (input.family !== "codex")
      throw new HistoryStorageConflictError("destination-family-unsupported");
    const configPath = path.join(input.paseoHome, "config.json");
    const configInventory: Inventory = { issues: [], visited: 0 };
    if (!(await regularPath(configPath, configInventory))) {
      result.issues.push(...configInventory.issues);
      throw new HistoryStorageConflictError("destination-config-missing-or-linked");
    }
    const configStat = await lstat(configPath);
    if (!configStat.isFile() || configStat.nlink > 1)
      throw new HistoryStorageConflictError("destination-config-not-ordinary");
    const persisted = readPersistedConfig(input.paseoHome);
    const profile = resolveConfiguredCodexHistoryProfile(
      provider,
      ProviderOverridesSchema.parse(persisted.agents?.providers ?? {}),
    );
    if (profile.historyPolicy?.mode !== "configured")
      throw new HistoryStorageConflictError("destination-history-not-configured");
    const storage = await resolveConfiguredCodexHistory({
      policy: profile.historyPolicy,
      runtimeSettings: profile.runtimeSettings,
      profileOptions: profile.providerOptions,
      env: profile.runtimeSettings?.env ?? {},
    });
    if (!storage) throw new HistoryStorageConflictError("destination-history-not-configured");
    result.storage = storage;
    result.sourceOverlap = await historyRootsOverlap(
      { home: input.providerHome, sqliteHome: input.sqliteHome ?? input.providerHome },
      storage,
    );
    const destination = await previewProviderHistory(
      {
        paseoHome: input.paseoHome,
        provider,
        family: "codex",
        providerHome: storage.home,
        sqliteHome: storage.sqliteHome,
      },
      reader,
    );
    const found = new Set(destination.sessions.map((session) => session.id));
    result.collidingSessionIds = [
      ...new Set(source.filter((session) => found.has(session.id)).map((session) => session.id)),
    ].sort();
    result.inventoryDigest = destination.digest;
    result.sessionCount = destination.sessions.length;
    result.issues.push(...destination.issues);
    if (result.sourceOverlap)
      result.issues.push({ code: "destination-overlaps-source", path: storage.home });
    if (result.collidingSessionIds.length)
      result.issues.push({ code: "destination-session-id-conflict", path: storage.home });
    result.admission =
      result.sourceOverlap || result.collidingSessionIds.length ? "conflict" : "configured";
    result.issues.push({
      code: "destination-launch-environment-and-managed-policy-unverified",
      path: storage.home,
    });
  } catch (error) {
    result.admission = error instanceof HistoryStorageConflictError ? "conflict" : "unavailable";
    result.issues.push({
      code:
        error instanceof HistoryStorageConflictError
          ? error.reason
          : "destination-config-or-inventory-unavailable",
      path: input.paseoHome,
    });
  }
  return result;
}
