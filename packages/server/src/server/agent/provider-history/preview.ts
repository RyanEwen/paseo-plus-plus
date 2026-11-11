import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { readPersistedConfig } from "../../persisted-config.js";
import {
  ProviderOverridesSchema,
  resolveConfiguredCodexHistoryProfile,
} from "../provider-launch-config.js";
import { historyRootsOverlap, resolveConfiguredCodexHistory } from "../providers/codex/history.js";
import { HistoryStorageConflictError } from "./binding.js";
import { candidates } from "./preview/classify.js";
import { artifacts, readRecords, readSessions, regularPath } from "./preview/scan.js";
import {
  type HistoryPreviewDatabaseReader,
  database,
  sqliteHistoryReader,
} from "./preview/sqlite.js";
import {
  type DatabaseInventory,
  type HistoryPreviewInput,
  type Inventory,
  type ProviderHistoryPreview,
  type SessionCandidate,
  type SpawnEdge,
  type UnresolvedHistoryIntent,
} from "./preview/types.js";

export type { HistoryPreviewInput, ProviderHistoryPreview } from "./preview/types.js";
export { sqliteHistoryReader, type HistoryPreviewDatabaseReader } from "./preview/sqlite.js";

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
