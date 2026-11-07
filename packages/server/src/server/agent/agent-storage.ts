import {
  HistoryIntentConflictError,
  HistoryIdentityCommittedError,
  HistoryStorageConflictError,
  sameHistoryStorage,
  preserveSnapshotHistoryBinding,
  ProviderHistoryBindingSchema,
  type ProviderHistoryStorage,
} from "./provider-history/binding.js";
import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { AgentFeatureSchema, AgentStatusSchema } from "../messages.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import type { ManagedAgent } from "./agent-manager.js";
import type { AgentPersistenceHandle, AgentSessionConfig } from "./agent-sdk-types.js";
import { AgentOwnerSchema, daemonExecutionKey, type DaemonAgentOwner } from "./agent-owner.js";

const SERIALIZABLE_CONFIG_SCHEMA = z
  .object({
    modeId: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    thinkingOptionId: z.string().nullable().optional(),
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

const STORED_AGENT_SCHEMA = z.object({
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
  features: z.array(AgentFeatureSchema).optional(),
  persistence: PERSISTENCE_HANDLE_SCHEMA,
  lastError: z.string().nullable().optional(),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: z.string().nullable().optional(),
  internal: z.boolean().optional(),
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
  | "featureValues"
  | "providerOptions"
  | "toolPolicy"
  | "systemPrompt"
  | "mcpServers"
>;

export type StoredAgentRecord = z.infer<typeof STORED_AGENT_SCHEMA>;
export function parseStoredAgentRecord(value: unknown): StoredAgentRecord {
  return STORED_AGENT_SCHEMA.parse(value);
}

/** A registered Claude creation in a configured home that has not received its first native ID. */
export function isBoundEmptyClaudeCreation(record: StoredAgentRecord | null | undefined): boolean {
  if (!record) return false;
  const binding = record.providerHistory;
  const awaitingNativeIdentity = !record.persistence && !record.claudeFreshRewind;
  const registeredCreation =
    binding?.origin === "created" &&
    binding.registration === "registered" &&
    binding.sessionId === null;
  const configuredClaudeHome =
    binding?.storage.kind === "configured-home" && binding.storage.provider === "claude";
  return awaitingNativeIdentity && registeredCreation && configuredClaudeHome;
}
function matchesEmptyClaudeRecreation(
  existing: StoredAgentRecord | null,
  requested: StoredAgentRecord,
): boolean {
  if (!existing || !isBoundEmptyClaudeCreation(existing)) return false;
  const requestsEmptyCreation =
    requested.providerHistory?.origin === "created" && requested.providerHistory.sessionId === null;
  const samePlacement =
    existing.provider === requested.provider &&
    existing.cwd === requested.cwd &&
    existing.workspaceId === requested.workspaceId;
  const sameLaunch =
    digest(existing.config) === digest(requested.config) &&
    digest(existing.launchEnv ?? null) === digest(requested.launchEnv ?? null);
  return requestsEmptyCreation && samePlacement && sameLaunch;
}

// The pending initial/fresh query protects routing identity, not activity/status metadata.
function claudeQueryIdentity(record: StoredAgentRecord) {
  return {
    id: record.id,
    provider: record.provider,
    cwd: record.cwd,
    workspaceId: record.workspaceId,
    archivedAt: record.archivedAt,
    config: record.config,
    launchEnv: record.launchEnv,
    persistence: record.persistence,
    providerHistory: record.providerHistory,
    claudeFreshRewind: record.claudeFreshRewind,
  };
}
function assertClaudeQueryAdmission(expected: StoredAgentRecord, current: StoredAgentRecord): void {
  if (digest(claudeQueryIdentity(expected)) !== digest(claudeQueryIdentity(current)))
    throw new HistoryStorageConflictError("query-admission-identity-changed");
}

function assertClaudeRewindNext(
  current: StoredAgentRecord,
  next: AgentPersistenceHandle,
  operationId: string | undefined,
): void {
  const sameProvider = next.provider === current.provider;
  const newNativeSession =
    !!next.sessionId &&
    next.sessionId !== current.providerHistory?.sessionId &&
    next.nativeHandle === next.sessionId;
  const matchesPendingOperation = current.claudeFreshRewind?.operationId === operationId;
  if (!sameProvider || !newNativeSession || !matchesPendingOperation)
    throw new HistoryStorageConflictError("rewind-handle-conflict");
}
function assertPendingClaudeQuerySnapshot(
  current: ManagedAgent,
  existing: StoredAgentRecord | null,
): void {
  const admission =
    current.session?.claudeFreshRewind?.admission ??
    current.session?.claudeInitialHistory?.admission ??
    current.historyQueryAdmission;
  if (admission && existing) assertClaudeQueryAdmission(admission, existing);
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

export interface AgentSnapshotOptions {
  /** Manager registration only: atomically publish a created Claude chat before its lazy first native ID. */
  registerClaudeEmptyCreation?: boolean;
  title?: string | null;
  internal?: boolean;
}

interface AgentStorageReadOptions {
  includeHistoryIntents?: boolean;
}

function includeRecord(record: StoredAgentRecord, options?: AgentStorageReadOptions): boolean {
  return (
    options?.includeHistoryIntents === true || record.providerHistory?.registration !== "intent"
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class AgentStorage {
  private cache: Map<string, StoredAgentRecord> = new Map();
  private pathById: Map<string, string> = new Map();
  private pathsById: Map<string, Set<string>> = new Map();
  private pendingWrites: Map<string, Promise<void>> = new Map();
  private deleting: Set<string> = new Set();
  private daemonAgentIdsByExecution: Map<string, string> = new Map();
  private daemonExecutionKeysByAgentId: Map<string, string> = new Map();
  private loaded = false;
  private baseDir: string;
  private loadPromise: Promise<StoredAgentRecord[]> | null = null;
  private logger: Logger;

  constructor(baseDir: string, logger: Logger) {
    this.baseDir = baseDir;
    this.logger = logger.child({ module: "agent", component: "agent-storage" });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async list(options?: AgentStorageReadOptions): Promise<StoredAgentRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter((record) => includeRecord(record, options));
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
    const records = await this.list();
    return records.filter(
      (record) =>
        record.persistence?.provider === provider &&
        (record.persistence.sessionId === providerHandleId ||
          record.persistence.nativeHandle === providerHandleId),
    );
  }

  async listByWorkspace(workspaceId: string): Promise<StoredAgentRecord[]> {
    const records = await this.list();
    return records.filter((record) => record.workspaceId === workspaceId);
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

  async captureClaudeHistoryAdmission(agentId: string): Promise<StoredAgentRecord> {
    await this.load();
    let captured: StoredAgentRecord | undefined;
    await this.queueRecordMutation(agentId, (current) => {
      if (current) captured = structuredClone(current);
      return null;
    });
    if (!captured) throw new HistoryStorageConflictError("history-admission-record-missing");
    return captured;
  }

  async commitClaudeInitialHandle(input: {
    expected: StoredAgentRecord;
    next: AgentPersistenceHandle;
    onCommitted(record: StoredAgentRecord): void;
    assertCurrent?(): void;
  }): Promise<void> {
    await this.load();
    let committed = false;
    await this.queueRecordMutation(
      input.expected.id,
      (current) => {
        input.assertCurrent?.();
        const binding = current?.providerHistory;
        if (!current) throw new HistoryStorageConflictError("initial-handle-binding-conflict");
        assertClaudeQueryAdmission(input.expected, current);
        const stillEmpty = !current.persistence && !current.claudeFreshRewind;
        const registeredClaudeCreation =
          binding?.registration === "registered" &&
          binding.origin === "created" &&
          binding.sessionId === null &&
          binding.storage.kind === "configured-home" &&
          binding.storage.provider === "claude";
        const nextIsNativeSession =
          !!input.next.sessionId &&
          input.next.provider === current.provider &&
          input.next.nativeHandle === input.next.sessionId;
        if (!stillEmpty || !registeredClaudeCreation || !nextIsNativeSession || !binding)
          throw new HistoryStorageConflictError("initial-handle-binding-conflict");
        return {
          ...current,
          persistence: input.next,
          providerHistory: { ...binding, sessionId: input.next.sessionId },
          runtimeInfo: current.runtimeInfo
            ? { ...current.runtimeInfo, sessionId: input.next.sessionId }
            : undefined,
        };
      },
      () => {
        committed = true;
        const record = this.cache.get(input.expected.id)!;
        try {
          input.onCommitted(record);
        } catch {
          throw new HistoryIdentityCommittedError(record.persistence?.sessionId);
        }
      },
    );
    if (!committed) throw new HistoryStorageConflictError("history-identity-write-refused");
  }

  /** Deliberate manager-owned Claude rewind; ordinary snapshots cannot change native identity. */
  async commitClaudeRewind(input: {
    expected: StoredAgentRecord;
    next?: AgentPersistenceHandle;
    freshOperationId?: string;
    onCommitted(record: StoredAgentRecord): void;
    assertCurrent?(): void;
  }): Promise<void> {
    await this.load();
    let committed = false;
    // A marked fresh query starts a turn before its first native init. Activity/status
    // snapshots may advance meanwhile; the exact route, recovery handle, config and intent may not.
    await this.queueRecordMutation(
      input.expected.id,
      (current) => {
        input.assertCurrent?.();
        if (!current) throw new HistoryStorageConflictError("rewind-canonical-record-changed");
        const binding = current.providerHistory;
        // A pending fresh query may advance activity metadata; compare only its routing identity.
        const comparesQueryIdentity = !!input.freshOperationId && !!current.claudeFreshRewind;
        const recordUnchanged = comparesQueryIdentity
          ? digest(claudeQueryIdentity(current)) === digest(claudeQueryIdentity(input.expected))
          : digest(current) === digest(input.expected);
        const registeredClaudeHome =
          binding?.registration === "registered" &&
          binding.storage.kind === "configured-home" &&
          binding.storage.provider === "claude";
        const bindingMatchesHandle =
          !!current.persistence &&
          binding?.sessionId === current.persistence.sessionId &&
          current.persistence.provider === current.provider;
        if (!recordUnchanged || !registeredClaudeHome || !bindingMatchesHandle || !binding)
          throw new HistoryStorageConflictError("rewind-canonical-record-changed");
        if (input.next) {
          const next = input.next;
          assertClaudeRewindNext(current, next, input.freshOperationId);
          return {
            ...current,
            persistence: next,
            providerHistory: { ...binding, sessionId: next.sessionId },
            runtimeInfo: current.runtimeInfo
              ? { ...current.runtimeInfo, sessionId: next.sessionId }
              : undefined,
            claudeFreshRewind: undefined,
          };
        }
        if (!input.freshOperationId || current.claudeFreshRewind)
          throw new HistoryStorageConflictError("rewind-intent-conflict");
        return { ...current, claudeFreshRewind: { operationId: input.freshOperationId } };
      },
      () => {
        committed = true;
        const record = this.cache.get(input.expected.id)!;
        try {
          input.onCommitted(record);
        } catch {
          throw new HistoryIdentityCommittedError(record.persistence?.sessionId);
        }
      },
    );
    if (!committed) throw new HistoryStorageConflictError("history-identity-write-refused");
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

    await writeJsonFileAtomic(nextPath, record);
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
    await this.queueRecordMutation(agent.id, (existing) => {
      assertPendingClaudeQuerySnapshot(agent, existing);
      const record = toStoredAgentRecord(agent, {
        title: hasTitleOverride ? (options?.title ?? null) : (existing?.title ?? null),
        createdAt: existing?.createdAt,
        internal: hasInternalOverride ? options?.internal : (agent.internal ?? existing?.internal),
      });

      // Older adapters and snapshots do not own daemon history provenance.
      record.providerHistory = snapshotHistoryBinding(
        existing,
        agent,
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
      record.resumeOnStartup = shouldResumeSnapshotOnStartup(existing, agent);
      return record;
    });
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

  private async load(): Promise<StoredAgentRecord[]> {
    if (this.loaded) {
      return Array.from(this.cache.values());
    }

    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }

    return this.loadPromise;
  }

  private async doLoad(): Promise<StoredAgentRecord[]> {
    this.cache.clear();
    this.pathById.clear();
    this.pathsById.clear();
    this.daemonAgentIdsByExecution.clear();
    this.daemonExecutionKeysByAgentId.clear();

    try {
      const records = await this.scanDisk();
      this.loaded = true;
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return [];
      }
      this.logger.error({ err: error }, "Failed to load agents");
      this.loaded = true;
      return [];
    }
  }

  private async scanDisk(): Promise<StoredAgentRecord[]> {
    const records: StoredAgentRecord[] = [];
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
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
      records.push(record);
      this.cache.set(record.id, record);
      this.indexOwner(record);
      this.pathById.set(record.id, filePath);
      this.addIndexedPath(record.id, filePath);
    }

    return records;
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

function claudeEmptyCreationBinding(
  existing: StoredAgentRecord,
  current: ManagedAgent,
  record: StoredAgentRecord,
): StoredAgentRecord["providerHistory"] {
  const previous = existing.providerHistory!;
  const createdWithoutSession = previous.origin === "created" && previous.sessionId === null;
  const noNativeHandle = !record.persistence && !existing.persistence;
  const configuredClaudeHome =
    previous.storage.kind === "configured-home" && previous.storage.provider === "claude";
  const sameCreatedRoute =
    current.provider === existing.provider &&
    current.providerHistory?.origin === "created" &&
    sameHistoryStorage(previous.storage, current.providerHistory.storage);
  if (!createdWithoutSession || !noNativeHandle || !configuredClaudeHome || !sameCreatedRoute)
    throw new HistoryStorageConflictError("empty-creation-registration-conflict");
  return { ...previous, registration: "registered" };
}

function snapshotHistoryBinding(
  existing: StoredAgentRecord | null,
  current: ManagedAgent,
  projected: StoredAgentRecord,
  registerEmptyCreation = false,
): StoredAgentRecord["providerHistory"] {
  if (registerEmptyCreation && existing?.providerHistory?.registration === "intent")
    return claudeEmptyCreationBinding(existing, current, projected);
  const previous = existing?.providerHistory;
  if (previous?.storage.kind === "configured-home") {
    // Projection normalizes registration; validate the original observation first.
    return preserveSnapshotHistoryBinding(previous, current.providerHistory, projected.persistence);
  }
  return projected.providerHistory ?? previous;
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
