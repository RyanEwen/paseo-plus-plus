import {
  HistoryIntentConflictError,
  HistoryStorageConflictError,
  sameHistoryStorage,
  ProviderHistoryBindingSchema,
  stableDigest as digest,
  type ProviderHistoryStorage,
} from "./provider-history/binding.js";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { AgentFeatureSchema, AgentOptionControlSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import {
  assertPendingClaudeQuerySnapshot,
  matchesEmptyClaudeRecreation,
  snapshotHistoryBinding,
} from "./provider-history/claude-identity.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";
import { StoredAttentionObjectivesSchema } from "./attention/objectives.js";
import { controlsFromFeatures } from "@getpaseo/protocol/option-controls";
import { foldFeatureValues } from "./option-controls.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
    // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read-only; folded on parse.
    featureValues: z.record(z.string(), z.unknown()).nullable().optional(),
    providerOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    toolPolicy: z
      .object({
        preapproved: z.array(
          z.object({ kind: z.literal("mcp"), server: z.string(), tool: z.string() }).strict(),
        ),
      })
      .strict()
      .nullable()
      .optional(),
    systemPrompt: z.string().nullable().optional(),
    mcpServers: z.record(z.string(), z.any()).nullable().optional(),
  })
  .nullable()
  .optional();

const PERSISTENCE_HANDLE_SCHEMA = z
  .object({
    provider: z.string(),
    sessionId: z.string(),
    nativeHandle: z.any().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .nullable()
  .optional();

const RAW_STORED_AGENT_SCHEMA = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string().optional(),
  lastUserMessageAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  metadata: z.record(z.string(), z.custom<JsonValue>()).default({}),
  lastStatus: AgentStatusSchema.default("closed"),
  resumeOnStartup: z.boolean().optional(),
  lastModeId: z.string().nullable().optional(),
  config: SERIALIZABLE_CONFIG_SCHEMA,
  launchEnv: z.record(z.string(), z.string()).optional(),
  runtimeInfo: z
    .object({
      provider: z.string(),
      sessionId: z.string().nullable(),
      model: z.string().nullable().optional(),
      thinkingOptionId: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  controls: z.array(AgentOptionControlSchema).optional(),
  // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. Read-only; becomes controls.
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  attentionObjectives: StoredAttentionObjectivesSchema.optional(),
  humanAttentionRequired: z.boolean().optional(),
  attentionMessage: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  background: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  owner: AgentOwnerSchema.optional(),
  providerHistory: ProviderHistoryBindingSchema.optional(),
  claudeFreshRewind: z.object({ operationId: z.string().min(1) }).optional(),
});

export type SerializableAgentConfig = Pick<
  AgentSessionConfig,
  | "modeId"
  | "model"
  | "thinkingOptionId"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "mcpServers"
>;

type RawStoredAgentRecord = z.infer<typeof RAW_STORED_AGENT_SCHEMA>;
type RawStoredAgentConfig = NonNullable<RawStoredAgentRecord["config"]>;

/** Records carry `providerOptions` and `controls` only; legacy fields are folded when read. */
export type StoredAgentRecord = Omit<RawStoredAgentRecord, "config" | "features"> & {
  config?: Omit<RawStoredAgentConfig, "featureValues"> | null;
};

// COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
function foldLegacyRecordFields(record: RawStoredAgentRecord): StoredAgentRecord {
  const { features, config, controls, ...rest } = record;
  return {
    ...rest,
    ...(config ? { config: foldFeatureValues(config) } : { config }),
    ...((controls ?? features) ? { controls: controls ?? controlsFromFeatures(features) } : {}),
  };
}

const STORED_AGENT_SCHEMA = RAW_STORED_AGENT_SCHEMA.transform(foldLegacyRecordFields);

export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

/** Internal creation-runner proof, consumed only after the queued captured-record comparison. */
export interface HistoryIntentRetryAdmission {
  expected: StoredAgentRecord;
  consume(): void;
}

export function isUncommittedCreatedIntent(
  record: StoredAgentRecord | null | undefined,
): record is StoredAgentRecord {
  return (
    !!record &&
    record.providerHistory?.origin === "created" &&
    record.providerHistory.registration === "intent" &&
    record.providerHistory.sessionId === null &&
    !record.persistence &&
    !record.claudeFreshRewind &&
    !record.archivedAt &&
    !record.internal &&
    (record.runtimeInfo?.sessionId === undefined || record.runtimeInfo.sessionId === null)
  );
}

function matchesCreatedIntentRetry(
  current: StoredAgentRecord,
  requested: StoredAgentRecord,
): boolean {
  return (
    isUncommittedCreatedIntent(current) &&
    requested.providerHistory?.origin === "created" &&
    requested.providerHistory.registration === "intent" &&
    requested.providerHistory.sessionId === null &&
    current.id === requested.id &&
    current.provider === requested.provider &&
    current.cwd === requested.cwd &&
    current.workspaceId === requested.workspaceId &&
    current.internal === requested.internal &&
    digest(current.owner ?? null) === digest(requested.owner ?? null) &&
    digest(current.config) === digest(requested.config) &&
    digest(current.launchEnv ?? null) === digest(requested.launchEnv ?? null)
  );
}

/** Optional ownership hooks run inside the existing writer, without changing ordinary snapshots. */
export interface AgentSnapshotOperation {
  /** Resolve the current view when its queue entry runs; null skips this write and its callback. */
  resolveSnapshot(): ManagedAgent | null;
  /** Runs after persistence and cache update, before the next write; must be synchronous and not throw. */
  onCommitted?(): void;
}

export interface AgentSnapshotOptions {
  /** Manager registration only: atomically publish a created Claude chat before its lazy first native ID. */
  registerClaudeEmptyCreation?: boolean;
  title?: string | null;
  internal?: boolean;
  operation?: AgentSnapshotOperation;
}

interface AgentStorageReadOptions {
  includeHistoryIntents?: boolean;
}

function includeRecord(record: StoredAgentRecord, options?: AgentStorageReadOptions): boolean {
  return (
    options?.includeHistoryIntents === true || record.providerHistory?.registration !== "intent"
  );
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  private readonly idsByWorkspace = new Map<string, Set<string>>();
  private readonly workspaceById = new Map<string, string>();
  private readonly activeIds = new Set<string>();
  private readonly promptTimeByAgent = new Map<string, string>();
  private readonly promptTimes = new Map<string, string>();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<void> | null = null;
  private logger: Logger;

  private readonly writeRecordFile: (path: string, record: StoredAgentRecord) => Promise<void>;

  /**
   * `options.writeRecordFile` replaces the durable per-record write (an atomic JSON write by
   * default); tests use it to hold or fail one record's commit.
   */
  constructor(
    baseDir: string,
    logger: Logger,
    options?: { writeRecordFile?: (path: string, record: StoredAgentRecord) => Promise<void> },
  ) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
    this.writeRecordFile = options?.writeRecordFile ?? writeJsonFileAtomic;
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async listAll(options?: AgentStorageReadOptions): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter((record) => includeRecord(record, options));
  }

  async listActive(options?: { includeArchived?: boolean }): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(
      options?.includeArchived ? this.cache.keys() : this.activeIds,
      (id) => this.cache.get(id)!,
    ).filter((record) => includeRecord(record));
  }

  async listByWorkspaces(
    workspaceIds: Iterable<string>,
    options?: { includeArchived?: boolean },
  ): Promise<StoredAgentRecord[]> {
    await this.load();
    const records: StoredAgentRecord[] = [];
    for (const workspaceId of new Set(workspaceIds)) {
      for (const id of this.idsByWorkspace.get(workspaceId) ?? []) {
        const record = this.cache.get(id)!;
        if ((options?.includeArchived || !record.archivedAt) && includeRecord(record))
          records.push(record);
      }
    }
    return records;
  }

  async lastUserMessageAtByWorkspace(
    workspaceIds?: Iterable<string>,
    options?: { excludeAgentIds?: Iterable<string> },
  ): Promise<ReadonlyMap<string, string>> {
    await this.load();
    const times = new Map<string, string>();
    const excluded = new Set(options?.excludeAgentIds);
    const affected = new Set(Array.from(excluded, (id) => this.workspaceById.get(id)));
    for (const id of workspaceIds ?? this.promptTimes.keys()) {
      let at = this.promptTimes.get(id);
      if (affected.has(id)) {
        at = undefined;
        for (const agentId of this.idsByWorkspace.get(id) ?? []) {
          const record = this.cache.get(agentId)!;
          if (
            !excluded.has(agentId) &&
            !record.internal &&
            !record.background &&
            record.lastUserMessageAt &&
            record.lastUserMessageAt > (at ?? "")
          ) {
            at = record.lastUserMessageAt;
          }
        }
      }
      if (at) times.set(id, at);
    }
    return times;
  }

  private indexWorkspace(record: StoredAgentRecord): void {
    const previous = this.workspaceById.get(record.id);
    if (previous) this.idsByWorkspace.get(previous)?.delete(record.id);
    this.workspaceById.delete(record.id);
    this.activeIds.delete(record.id);
    if (!record.archivedAt) this.activeIds.add(record.id);
    if (record.workspaceId) {
      const ids = this.idsByWorkspace.get(record.workspaceId) ?? new Set<string>();
      ids.add(record.id);
      this.idsByWorkspace.set(record.workspaceId, ids);
      this.workspaceById.set(record.id, record.workspaceId);
    }
    this.indexPromptTime(record, previous);
  }

  private indexPromptTime(record: StoredAgentRecord, previous: string | undefined): void {
    const previousTime = this.promptTimeByAgent.get(record.id);
    const nextTime =
      !record.internal && !record.background ? (record.lastUserMessageAt ?? undefined) : undefined;
    if (nextTime) this.promptTimeByAgent.set(record.id, nextTime);
    else this.promptTimeByAgent.delete(record.id);
    if (previous === record.workspaceId && previousTime === nextTime) return;
    if (
      previous &&
      previousTime &&
      this.promptTimes.get(previous) === previousTime &&
      (previous !== record.workspaceId || !nextTime || nextTime < previousTime)
    ) {
      this.refreshPromptTime(previous);
    }
    if (
      record.workspaceId &&
      nextTime &&
      nextTime > (this.promptTimes.get(record.workspaceId) ?? "")
    ) {
      this.promptTimes.set(record.workspaceId, nextTime);
    }
  }

  private refreshPromptTime(workspaceId: string): void {
    this.promptTimes.delete(workspaceId);
    let latest = "";
    for (const id of this.idsByWorkspace.get(workspaceId) ?? []) {
      const record = this.cache.get(id)!;
      if (
        !record.internal &&
        !record.background &&
        record.lastUserMessageAt &&
        record.lastUserMessageAt > latest
      )
        latest = record.lastUserMessageAt;
    }
    if (latest) this.promptTimes.set(workspaceId, latest);
  }

  async get(agentId: string, options?: AgentStorageReadOptions): Promise<StoredAgentRecord | null> {
    await this.load();
    const record = this.cache.get(agentId);
    return record && includeRecord(record, options) ? record : null;
  }

  async listByProviderSession(
    provider: string,
    providerHandleId: string,
  ): Promise<StoredAgentRecord[]> {
    const records = await this.listAll();
    return records.filter(
      (record) =>
        record.persistence?.provider === provider &&
        (record.persistence.sessionId === providerHandleId ||
          record.persistence.nativeHandle === providerHandleId),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    return this.listByWorkspaces([workspaceId], { includeArchived: true });
  }

  async findByDaemonExecution(owner: DaemonAgentOwner): Promise<StoredAgentRecord | null> {
    await this.load();
    const agentId = this.daemonAgentIdsByExecution.get(daemonExecutionKey(owner));
    return agentId ? this.get(agentId) : null;
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    await this.load();
    await this.queueRecordWrite(record);
  }

  /** Apply a domain mutation to the current record inside its existing write queue. */
  async update(
    agentId: string,
    mutate: (record: StoredAgentRecord) => StoredAgentRecord,
  ): Promise<void> {
    await this.load();
    await this.queueRecordMutation(agentId, (existing) => {
      if (!existing) throw new Error(`Agent ${agentId} not found`);
      return mutate(existing);
    });
  }

  async reserveHistoryIntent(
    record: StoredAgentRecord,
    retry?: HistoryIntentRetryAdmission,
  ): Promise<StoredAgentRecord> {
    await this.load();
    let reserved = false;
    let selected = record;
    await this.queueRecordMutation(record.id, (existing) => {
      // Legacy startup failures already retry through createAgent with this ID. Preserve
      // their unknown provenance instead of retroactively calling the old session created.
      const legacyRetry = existing && !existing.persistence && !existing.providerHistory;
      const emptyRecreation = matchesEmptyClaudeRecreation(existing, record);
      if (existing && retry) {
        if (
          digest(existing) !== digest(retry.expected) ||
          !matchesCreatedIntentRetry(existing, record)
        )
          throw new HistoryIntentConflictError(record.id);
        retry.consume();
        reserved = true;
        selected = existing;
        return existing;
      }
      if (existing && !legacyRetry && !emptyRecreation)
        throw new HistoryIntentConflictError(record.id);
      reserved = true;
      if (legacyRetry || emptyRecreation) {
        selected = existing!;
        return existing;
      }
      return record;
    });
    if (!reserved) throw new HistoryIntentConflictError(record.id);
    return selected;
  }

  async assertInternalAgentIdAvailable(agentId: string): Promise<void> {
    await this.load();
    let checked = false;
    await this.queueRecordMutation(agentId, (existing) => {
      // Ephemeral utilities cannot reuse canonical IDs, including hidden failed intentions.
      if (existing) throw new HistoryIntentConflictError(agentId);
      checked = true;
      return null;
    });
    if (!checked) throw new HistoryIntentConflictError(agentId);
  }

  async bindHistoryIntent(agentId: string, storage: ProviderHistoryStorage): Promise<void> {
    await this.load();
    let bound = false;
    await this.queueRecordMutation(agentId, (current) => {
      if (!current?.providerHistory || current.providerHistory.registration !== "intent")
        throw new HistoryIntentConflictError(agentId);
      if (
        current.providerHistory.storage.kind !== "unknown" &&
        !sameHistoryStorage(current.providerHistory.storage, storage)
      )
        throw new HistoryStorageConflictError("intent-storage-already-bound");
      bound = true;
      return { ...current, providerHistory: { ...current.providerHistory, storage } };
    });
    if (!bound) throw new HistoryIntentConflictError(agentId);
  }

  /**
   * Run a mutation inside this record's write queue. Returning null leaves the record unwritten
   * (a queued read or check); `onCommitted` runs after the write and before the next queued
   * mutation, with the committed record.
   */
  async mutateRecord(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord | null,
    onCommitted?: (record: StoredAgentRecord) => void,
  ): Promise<void> {
    await this.load();
    await this.queueRecordMutation(
      agentId,
      mutate,
      onCommitted ? () => onCommitted(this.cache.get(agentId)!) : undefined,
    );
  }

  private queueRecordWrite(record: StoredAgentRecord): Promise<void> {
    return this.queueRecordMutation(record.id, () => record);
  }

  private queueRecordMutation(
    agentId: string,
    mutate: (existing: StoredAgentRecord | null) => StoredAgentRecord | null,
    onCommitted?: () => void,
  ): Promise<void> {
    const prev = this.pendingWrites.get(agentId) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (this.deleting.has(agentId)) {
        return undefined;
      }

      const record = mutate(this.cache.get(agentId) ?? null);
      if (!record) return undefined;
      await this.writeRecord(record);
      onCommitted?.();
      return undefined;
    });

    const tracked = next.finally(() => {
      if (this.pendingWrites.get(agentId) === tracked) {
        this.pendingWrites.delete(agentId);
      }
    });

    this.pendingWrites.set(agentId, tracked);
    return tracked;
  }

  private async writeRecord(record: StoredAgentRecord): Promise<void> {
    const agentId = record.id;
    const previousPath = this.pathById.get(agentId);
    const nextPath = this.buildRecordPath(record);

    await this.writeRecordFile(nextPath, record);
    this.addIndexedPath(agentId, nextPath);

    if (previousPath && previousPath !== nextPath) {
      try {
        await fs.unlink(previousPath);
      } catch {
        // ignore cleanup errors
      }
      this.removeIndexedPath(agentId, previousPath);
    }

    this.cache.set(agentId, record);
    this.indexOwner(record);
    this.pathById.set(agentId, nextPath);
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    await this.load();
    this.beginDelete(agentId);
    await (this.pendingWrites.get(agentId) ?? Promise.resolve());
    const paths = Array.from(this.pathsById.get(agentId) ?? []);
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code && code !== "ENOENT") {
            this.logger.warn(
              { err: error, agentId, filePath },
              "Failed to remove agent record file",
            );
          }
        }
      }),
    );

    const workspaceId = this.workspaceById.get(agentId);
    this.workspaceById.delete(agentId);
    this.promptTimeByAgent.delete(agentId);
    this.activeIds.delete(agentId);
    if (workspaceId) {
      this.idsByWorkspace.get(workspaceId)?.delete(agentId);
      this.refreshPromptTime(workspaceId);
    }
    this.cache.delete(agentId);
    this.removeOwnerIndex(agentId);
    this.pathById.delete(agentId);
    this.pathsById.delete(agentId);
  }

  async applySnapshot(agent: ManagedAgent, options?: AgentSnapshotOptions): Promise<void> {
    await this.load();
    const hasTitleOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "title");
    const hasInternalOverride =
      options !== undefined && Object.prototype.hasOwnProperty.call(options, "internal");
    await this.queueRecordMutation(
      agent.id,
      (existing) => {
        const current = options?.operation ? options.operation.resolveSnapshot() : agent;
        if (!current) return null;
        if (current.id !== agent.id) throw new Error("Snapshot resolver changed agent identity");
        assertPendingClaudeQuerySnapshot(current, existing);
        const record = toStoredAgentRecord(current, {
          title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
          createdAt: existing?.createdAt,
          internal: hasInternalOverride
            ? options?.internal
            : (current.internal ?? existing?.internal),
        });

        // Older adapters and snapshots do not own daemon history provenance.
        record.providerHistory = snapshotHistoryBinding(
          existing,
          current,
          record,
          options?.registerClaudeEmptyCreation,
        );
        // Only the explicit rewind queue operation can create/consume this recovery intent.
        record.claudeFreshRewind = existing?.claudeFreshRewind;

        // Preserve soft-delete/archive status across snapshot flushes. The
        // projection runs inside the per-agent write queue so it cannot commit a
        // stale pre-archive record after the archive mutation.
        if (existing && existing.archivedAt !== undefined) {
          record.archivedAt = existing.archivedAt;
        }
        // Background is fixed at creation; a runtime opened without it cannot clear it.
        if (existing?.background) record.background = true;
        record.resumeOnStartup = shouldResumeSnapshotOnStartup(existing, current);
        return record;
      },
      options?.operation?.onCommitted,
    );
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    await this.load();
    await this.waitForPendingWrite(agentId);
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
  }

  async flush(): Promise<void> {
    await this.load().catch(() => undefined);
    const writes = Array.from(this.pendingWrites.values());
    await Promise.allSettled(writes);
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();

    try {
      await this.scanDisk();
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
    }
  }

  private async scanDisk(): Promise<void> {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const rootRecordPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(this.baseDir, entry.name));

    const projectFileLists = await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const files = await fs.readdir(projectDir, { withFileTypes: true });
          return files
            .filter((file) => file.isFile() && file.name.endsWith(".json"))
            .map((file) => path.join(projectDir, file.name));
        } catch {
          return [];
        }
      }),
    );

    const allFilePaths = [...rootRecordPaths, ...projectFileLists.flat()];
    const loaded = await Promise.all(
      allFilePaths.map(async (filePath) => {
        const record = await this.readRecordFile(filePath);
        return record ? { record, filePath } : null;
      }),
    );

    for (const item of loaded) {
      if (!item) continue;
      const { record, filePath } = item;
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }
  }

  private async readRecordFile(filePath: string): Promise<StoredAgentRecord | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      return parseStoredAgentRecord(parsed);
    } catch (error) {
      this.logger.error({ err: error, filePath }, "Skipping invalid agent record");
      return null;
    }
  }

  private buildRecordPath(record: StoredAgentRecord): string {
    const projectDir = projectDirNameFromCwd(record.cwd);
    return path.join(this.baseDir, projectDir, `${record.id}.json`);
  }

  private addIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId) ?? new Set<string>();
    paths.add(filePath);
    this.pathsById.set(agentId, paths);
  }

  private removeIndexedPath(agentId: string, filePath: string): void {
    const paths = this.pathsById.get(agentId);
    if (!paths) {
      return;
    }
    paths.delete(filePath);
    if (paths.size === 0) {
      this.pathsById.delete(agentId);
    }
  }

  private indexOwner(record: StoredAgentRecord): void {
    this.indexWorkspace(record);
    this.removeOwnerIndex(record.id);
    if (record.owner?.kind === "daemon") {
      const key = daemonExecutionKey(record.owner);
      const previousAgentId = this.daemonAgentIdsByExecution.get(key);
      if (previousAgentId && previousAgentId !== record.id) {
        this.daemonExecutionKeysByAgentId.delete(previousAgentId);
      }
      this.daemonAgentIdsByExecution.set(key, record.id);
      this.daemonExecutionKeysByAgentId.set(record.id, key);
    }
  }

  private removeOwnerIndex(agentId: string): void {
    const key = this.daemonExecutionKeysByAgentId.get(agentId);
    if (!key) return;
    if (this.daemonAgentIdsByExecution.get(key) === agentId) {
      this.daemonAgentIdsByExecution.delete(key);
    }
    this.daemonExecutionKeysByAgentId.delete(agentId);
  }

  private async waitForPendingWrite(agentId: string): Promise<void> {
    await (this.pendingWrites.get(agentId) ?? Promise.resolve()).catch(() => undefined);
  }
}

function projectDirNameFromCwd(cwd: string): string {
  // path.win32.parse handles drive letters, UNC roots, and Unix roots on all platforms
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  // Sanitize root: strip colons and separators, keep letters (e.g. "C:\" → "C", "\\server\share\" → "server-share")
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

function shouldResumeSnapshotOnStartup(
  existing: StoredAgentRecord | null,
  snapshot: { lifecycle: string },
): boolean | undefined {
  return (
    existing?.resumeOnStartup && snapshot.lifecycle !== "idle" && snapshot.lifecycle !== "error"
  );
}
