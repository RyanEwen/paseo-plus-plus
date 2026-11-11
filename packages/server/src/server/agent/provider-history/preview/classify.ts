import path from "node:path";
import type { StoredAgentRecord } from "../../agent-storage.js";
import { claudeHistoryHome } from "../../providers/claude/history.js";
import type { ProviderHistoryStorage } from "../binding.js";
import {
  type HistoryPreviewInput,
  type SessionCandidate,
  type SessionFile,
  type SpawnEdge,
} from "./types.js";

interface SessionClassificationInput {
  family: HistoryPreviewInput["family"];
  file: SessionFile;
  owners: StoredAgentRecord[];
  copies: number;
  provider: string;
  sqliteHome: string;
}

/** The directory a recorded binding stores history in, as the provider resolves it. */
function storageHome(storage: Exclude<ProviderHistoryStorage, { kind: "unknown" }>): string {
  return storage.provider === "claude" ? claudeHistoryHome(storage) : path.resolve(storage.home);
}

/** A record that is mid-rewind, unregistered, or bound to a different native session. */
function recordsAnotherIdentity(record: StoredAgentRecord, file: SessionFile): boolean {
  if (record.claudeFreshRewind !== undefined) return true;
  const binding = record.providerHistory;
  if (binding === undefined) return false;
  const boundToThisFile =
    binding.sessionId === file.id && record.persistence?.sessionId === file.id;
  return binding.registration !== "registered" || !boundToThisFile;
}

/** A record whose recorded storage is another provider, home, or SQLite home than this file's. */
function recordsAnotherStorage(
  record: StoredAgentRecord,
  file: SessionFile,
  input: SessionClassificationInput,
): boolean {
  const storage = record.providerHistory?.storage;
  if (storage === undefined || storage.kind === "unknown") return false;
  const insideHome = file.source.startsWith(storageHome(storage) + path.sep);
  const otherSqliteHome =
    storage.kind === "configured-home" &&
    storage.provider === "codex" &&
    storage.sqliteHome !== input.sqliteHome;
  return storage.provider !== input.family || !insideHome || otherSqliteHome;
}

function classifySession(input: SessionClassificationInput): SessionCandidate {
  const { file, owners, copies, provider } = input;
  let provenance: SessionCandidate["provenance"] = owners.length ? "legacy" : "native-only";
  const origins = new Set(owners.map((record) => record.providerHistory?.origin));
  if (origins.size === 1 && origins.has("created")) provenance = "created";
  if (origins.size === 1 && origins.has("imported")) provenance = "imported";
  const identityConflict = owners.some((record) => recordsAnotherIdentity(record, file));
  const storageConflict = owners.some((record) => recordsAnotherStorage(record, file, input));
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

export function candidates(input: CandidateScope): SessionCandidate[] {
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
