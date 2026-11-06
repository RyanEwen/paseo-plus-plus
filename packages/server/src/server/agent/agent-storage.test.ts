import { describe, expect, test, beforeEach, afterEach } from "vitest";
import {
  ProviderHistoryStorageSchema,
  registerProviderHistory,
  sameHistoryStorage,
  preserveSnapshotHistoryBinding,
} from "./provider-history/binding.js";
import { toStoredAgentRecord } from "./agent-projections.js";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  AgentStorage,
  parseStoredAgentRecord as normalizeStoredRecord,
  type StoredAgentRecord,
} from "./agent-storage.js";
import { buildConfigOverrides, buildSessionConfig } from "../persistence-hooks.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentPermissionRequest,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";

type ManagedAgentOverrides = Omit<
  Partial<ManagedAgent>,
  "config" | "pendingPermissions" | "session" | "activeForegroundTurnId"
> & {
  config?: Partial<AgentSessionConfig>;
  pendingPermissions?: Map<string, AgentPermissionRequest>;
  session?: AgentSession | null;
  activeForegroundTurnId?: string | null;
  runtimeInfo?: ManagedAgent["runtimeInfo"];
  attention?: ManagedAgent["attention"];
};

function buildManagedAgentConfig(
  provider: AgentProvider,
  cwd: string,
  configOverrides: Partial<AgentSessionConfig>,
): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider,
    cwd,
    title: configOverrides.title,
    modeId: configOverrides.modeId ?? "plan",
    model: configOverrides.model ?? "gpt-5.1",
    thinkingOptionId: configOverrides.thinkingOptionId,
    providerOptions: configOverrides.providerOptions,
    toolPolicy: configOverrides.toolPolicy,
    systemPrompt: configOverrides.systemPrompt,
    mcpServers: configOverrides.mcpServers,
  };
  if (Object.prototype.hasOwnProperty.call(configOverrides, "featureValues")) {
    config.featureValues = configOverrides.featureValues;
  }
  return config;
}

function buildDefaultCapabilities() {
  return {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  };
}

function buildDefaultRuntimeInfo(params: {
  provider: AgentProvider;
  config: AgentSessionConfig;
  sessionId: string;
}) {
  return {
    provider: params.provider,
    sessionId: params.sessionId,
    model: params.config.model ?? null,
    modeId: params.config.modeId ?? null,
  };
}

interface ManagedAgentCore {
  provider: AgentProvider;
  cwd: string;
  lifecycle: ManagedAgent["lifecycle"];
  config: AgentSessionConfig;
  session: AgentSession | null;
  activeForegroundTurnId: string | null;
  now: Date;
}

function resolveManagedAgentCore(overrides: ManagedAgentOverrides): ManagedAgentCore {
  const now = overrides.updatedAt ?? new Date("2025-01-01T00:00:00.000Z");
  const provider = overrides.provider ?? "claude";
  const cwd = overrides.cwd ?? "/tmp/project";
  const lifecycle = overrides.lifecycle ?? "idle";
  const config = buildManagedAgentConfig(provider, cwd, overrides.config ?? {});
  const session = lifecycle === "closed" ? null : (overrides.session ?? ({} as AgentSession));
  const activeForegroundTurnId =
    overrides.activeForegroundTurnId ?? (lifecycle === "running" ? "test-turn-id" : null);
  return { provider, cwd, lifecycle, config, session, activeForegroundTurnId, now };
}

function createManagedAgent(overrides: ManagedAgentOverrides = {}): ManagedAgent {
  const core = resolveManagedAgentCore(overrides);
  return {
    id: overrides.id ?? "agent-test",
    provider: core.provider,
    cwd: core.cwd,
    workspaceId: overrides.workspaceId,
    session: core.session,
    capabilities: overrides.capabilities ?? buildDefaultCapabilities(),
    config: core.config,
    lifecycle: core.lifecycle,
    createdAt: overrides.createdAt ?? core.now,
    updatedAt: overrides.updatedAt ?? core.now,
    availableModes: overrides.availableModes ?? [],
    currentModeId: overrides.currentModeId ?? core.config.modeId ?? null,
    pendingPermissions: overrides.pendingPermissions ?? new Map<string, AgentPermissionRequest>(),
    activeForegroundTurnId: core.activeForegroundTurnId,
    foregroundTurnWaiters: new Set(),
    unsubscribeSession: null,
    timeline: overrides.timeline ?? [],
    attention: overrides.attention ?? { requiresAttention: false },
    runtimeInfo:
      overrides.runtimeInfo ??
      buildDefaultRuntimeInfo({
        provider: core.provider,
        config: core.config,
        sessionId: overrides.sessionId ?? "session-123",
      }),
    persistence: overrides.persistence ?? null,
    providerHistory: overrides.providerHistory,
    historyPrimed: overrides.historyPrimed ?? true,
    lastUserMessageAt: overrides.lastUserMessageAt ?? core.now,
    lastUsage: overrides.lastUsage,
    lastError: overrides.lastError,
  };
}

describe("AgentStorage", () => {
  let tmpDir: string;
  let storagePath: string;
  let storage: AgentStorage;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
    storagePath = path.join(tmpDir, "agents");
    storage = new AgentStorage(storagePath, logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("internal history admission waits for queued records and never creates provenance", async () => {
    const record = toStoredAgentRecord(createManagedAgent({ id: "internal-collision" }));
    record.providerHistory = {
      origin: "imported",
      registration: "intent",
      sessionId: "native-kept",
      storage: { kind: "unknown" },
    };
    const publication = storage.upsert(record);
    const admission = storage.assertInternalAgentIdAvailable(record.id);
    await publication;
    await expect(admission).rejects.toThrow("history intent was not reserved");
    expect(await storage.get(record.id)).toBeNull();
    expect(await storage.get(record.id, { includeHistoryIntents: true })).toEqual(record);
    await storage.assertInternalAgentIdAvailable("fresh-internal");
    expect(await storage.get("fresh-internal", { includeHistoryIntents: true })).toBeNull();
    expect(
      await new AgentStorage(storagePath, logger).list({ includeHistoryIntents: true }),
    ).toEqual([normalizeStoredRecord(record)]);
  });

  test("history binding survives legacy adapter snapshots, archive writes and disk reload", async () => {
    const binding = {
      origin: "imported" as const,
      registration: "registered" as const,
      sessionId: "native-selected",
      storage: {
        kind: "unverified" as const,
        provider: "codex" as const,
        home: path.join(tmpDir, "custom-home"),
      },
    };
    const agent = createManagedAgent({
      id: "history-binding",
      provider: "codex-work",
      providerHistory: binding,
      persistence: { provider: "codex-work", sessionId: "native-selected" },
    });
    await storage.applySnapshot(agent);
    await storage.update(agent.id, (record) => ({ ...record, archivedAt: "2026-01-01T00:00:00Z" }));
    await storage.applySnapshot({ ...agent, providerHistory: undefined });
    const record = await new AgentStorage(storagePath, logger).get(agent.id);
    expect(record?.providerHistory).toEqual(binding);
    expect(record?.archivedAt).toBe("2026-01-01T00:00:00Z");
    expect(record?.persistence?.provider).toBe("codex-work");
    if (!record) throw new Error("Expected persisted fixture record");
    expect(buildStoredAgentPayload(record, ["codex-work"]).persistence?.sessionId).toBe(
      "native-selected",
    );
  });

  test("an intent reservation cannot overwrite an existing agent or another request", async () => {
    const existing = createManagedAgent({
      id: "existing-history",
      persistence: { provider: "codex", sessionId: "existing-session" },
    });
    await storage.applySnapshot(existing);
    const record = await storage.get(existing.id);
    if (!record) throw new Error("Expected existing record");
    await expect(storage.reserveHistoryIntent(record)).rejects.toMatchObject({
      code: "HISTORY_INTENT_CONFLICT",
    });
    expect(await storage.get(existing.id)).toEqual(record);
    const next: StoredAgentRecord = {
      id: "new-history",
      provider: "codex",
      cwd: tmpDir,
      labels: {},
      lastStatus: "closed",
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      providerHistory: {
        origin: "created",
        registration: "intent",
        sessionId: null,
        storage: { kind: "unknown" },
      },
    };
    const reservations = await Promise.allSettled([
      storage.reserveHistoryIntent(next),
      storage.reserveHistoryIntent(next),
    ]);
    expect(reservations.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    const reloaded = new AgentStorage(storagePath, logger);
    expect(await reloaded.get(next.id)).toBeNull();
    expect(await reloaded.get(next.id, { includeHistoryIntents: true })).toEqual(next);
  });

  function retryIntent(id: string): StoredAgentRecord {
    return {
      id,
      provider: "codex",
      cwd: tmpDir,
      workspaceId: "retry-workspace",
      labels: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      lastStatus: "closed",
      config: { model: "model-a" },
      launchEnv: { ROUTE: "one" },
      providerHistory: {
        origin: "created",
        registration: "intent",
        sessionId: null,
        storage: {
          kind: "configured-home",
          provider: "codex",
          home: path.join(tmpDir, "profile"),
          sqliteHome: path.join(tmpDir, "db"),
        },
      },
    };
  }

  test("a one-shot admitted retry preserves its original configured intention and timestamps", async () => {
    const original = retryIntent("retry-once");
    await storage.reserveHistoryIntent(original);
    const expected = structuredClone(original);
    let consumed = false;
    const admission = {
      expected,
      consume() {
        if (consumed) throw new Error("already consumed");
        consumed = true;
      },
    };
    const requested = {
      ...original,
      createdAt: "2026-02-02T00:00:00Z",
      updatedAt: "2026-02-02T00:00:00Z",
      providerHistory: { ...original.providerHistory!, storage: { kind: "unknown" as const } },
    };
    expect(await storage.reserveHistoryIntent(requested, admission)).toEqual(original);
    await expect(storage.reserveHistoryIntent(requested, admission)).rejects.toThrow(
      "already consumed",
    );
    expect(
      await new AgentStorage(storagePath, logger).get(original.id, { includeHistoryIntents: true }),
    ).toEqual(original);
  });

  test.each(["config", "env", "cwd", "workspace", "owner", "internal"])(
    "retry rejects changed requested %s without consuming authority",
    async (field) => {
      const original = retryIntent("requested-drift");
      await storage.reserveHistoryIntent(original);
      const requested = structuredClone(original);
      if (field === "config") requested.config = { model: "model-b" };
      if (field === "env") requested.launchEnv = { ROUTE: "two" };
      if (field === "cwd") requested.cwd += "/changed";
      if (field === "workspace") requested.workspaceId = "other-workspace";
      if (field === "internal") requested.internal = true;
      if (field === "owner")
        requested.owner = {
          kind: "daemon",
          daemonId: "other-daemon",
          executionId: "other-execution",
        };
      const consume = vi.fn();
      await expect(
        storage.reserveHistoryIntent(requested, { expected: structuredClone(original), consume }),
      ).rejects.toMatchObject({ code: "HISTORY_INTENT_CONFLICT" });
      expect(consume).not.toHaveBeenCalled();
      expect(await storage.get(original.id, { includeHistoryIntents: true })).toEqual(original);
    },
  );

  test.each(["config", "env", "registration", "native", "runtime", "archive", "fresh", "binding"])(
    "queued retry rejects intervening %s changes without overwriting durable state",
    async (field) => {
      const original = retryIntent("queued-drift");
      await storage.reserveHistoryIntent(original);
      const expected = structuredClone(original);
      const changed = structuredClone(original);
      if (field === "config") changed.config = { model: "model-b" };
      if (field === "env") changed.launchEnv = { ROUTE: "two" };
      if (field === "registration") changed.providerHistory!.registration = "registered";
      if (field === "native") changed.providerHistory!.sessionId = "committed-native";
      if (field === "runtime")
        changed.runtimeInfo = { provider: "codex", sessionId: "native-runtime" };
      if (field === "archive") changed.archivedAt = "2026-02-02T00:00:00Z";
      if (field === "fresh") changed.claudeFreshRewind = { operationId: "fresh-intent" };
      if (field === "binding") changed.providerHistory!.storage = { kind: "unknown" };
      const mutation = storage.update(original.id, () => changed);
      const consume = vi.fn();
      const retry = storage.reserveHistoryIntent(original, { expected, consume });
      await mutation;
      await expect(retry).rejects.toMatchObject({ code: "HISTORY_INTENT_CONFLICT" });
      expect(consume).not.toHaveBeenCalled();
      expect(
        await new AgentStorage(storagePath, logger).get(original.id, {
          includeHistoryIntents: true,
        }),
      ).toEqual(changed);
    },
  );

  test.each(["imported", "registered", "native", "runtime", "archive", "fresh"])(
    "captured %s records cannot use creation retry even when CAS matches",
    async (field) => {
      const original = retryIntent("inadmissible-retry");
      await storage.reserveHistoryIntent(original);
      const invalid = structuredClone(original);
      if (field === "imported") invalid.providerHistory!.origin = "imported";
      if (field === "registered") invalid.providerHistory!.registration = "registered";
      if (field === "native") invalid.providerHistory!.sessionId = "native-known";
      if (field === "runtime")
        invalid.runtimeInfo = { provider: "codex", sessionId: "native-known" };
      if (field === "archive") invalid.archivedAt = "2026-02-02T00:00:00Z";
      if (field === "fresh") invalid.claudeFreshRewind = { operationId: "fresh-operation" };
      await storage.update(original.id, () => invalid);
      const consume = vi.fn();
      await expect(
        storage.reserveHistoryIntent(original, { expected: structuredClone(invalid), consume }),
      ).rejects.toMatchObject({ code: "HISTORY_INTENT_CONFLICT" });
      expect(consume).not.toHaveBeenCalled();
      expect(await storage.get(original.id, { includeHistoryIntents: true })).toEqual(invalid);
    },
  );

  test("configured intent binding is durable, hidden and immutable across older snapshots", async () => {
    const agent = createManagedAgent({ id: "bound-intent", provider: "codex-work" });
    const record = toStoredAgentRecord(agent);
    record.persistence = undefined;
    record.providerHistory = {
      origin: "created",
      registration: "intent",
      sessionId: null,
      storage: { kind: "unknown" },
    };
    expect(await storage.reserveHistoryIntent(record)).toEqual(record);
    const selected = {
      kind: "configured-home" as const,
      provider: "codex" as const,
      home: path.join(tmpDir, "profile"),
      sqliteHome: path.join(tmpDir, "db"),
    };
    await storage.bindHistoryIntent(agent.id, selected);
    await storage.bindHistoryIntent(agent.id, {
      sqliteHome: selected.sqliteHome,
      home: selected.home,
      provider: selected.provider,
      kind: selected.kind,
    });
    await expect(
      storage.bindHistoryIntent(agent.id, { ...selected, sqliteHome: "/different" }),
    ).rejects.toMatchObject({ reason: "intent-storage-already-bound" });
    const reopened = new AgentStorage(storagePath, logger);
    expect(await reopened.get(agent.id)).toBeNull();
    expect(
      (await reopened.get(agent.id, { includeHistoryIntents: true }))?.providerHistory?.storage,
    ).toEqual(selected);
    await storage.applySnapshot({
      ...agent,
      providerHistory: {
        ...record.providerHistory,
        registration: "registered",
        sessionId: "stable-native-id",
        storage: selected,
      },
      persistence: { provider: "codex-work", sessionId: "stable-native-id" },
    });
    await storage.applySnapshot({
      ...agent,
      providerHistory: { ...record.providerHistory, registration: "registered" },
      persistence: { provider: "codex-work", sessionId: "stable-native-id" },
    });
    expect((await storage.get(agent.id))?.providerHistory?.storage).toEqual(selected);
    await expect(
      storage.applySnapshot({
        ...agent,
        providerHistory: { ...record.providerHistory, storage: { ...selected, home: "/changed" } },
        persistence: { provider: "codex-work", sessionId: "stable-native-id" },
      }),
    ).rejects.toMatchObject({ reason: "snapshot-storage-changed" });
    expect(
      (await new AgentStorage(storagePath, logger).get(agent.id))?.providerHistory?.storage,
    ).toEqual(selected);
    const registered = {
      ...record.providerHistory,
      registration: "registered" as const,
      sessionId: "stable-native-id",
      storage: selected,
    };
    await storage.applySnapshot({
      ...agent,
      providerHistory: registered,
      persistence: { provider: "codex-work", sessionId: "stable-native-id" },
    });
    await expect(
      storage.applySnapshot({
        ...agent,
        providerHistory: registered,
        persistence: { provider: "codex-work", sessionId: "changed-native-id" },
      }),
    ).rejects.toMatchObject({ reason: "bound-session-id-changed" });
    expect((await storage.get(agent.id))?.persistence?.sessionId).toBe("stable-native-id");
    await expect(
      storage.applySnapshot({
        ...agent,
        providerHistory: registered,
        persistence: {
          provider: "codex-work",
          sessionId: "stable-native-id",
          nativeHandle: "other-thread",
        },
      }),
    ).rejects.toMatchObject({ reason: "bound-native-handle-conflict" });

    await storage.remove(agent.id);
    await expect(storage.bindHistoryIntent(agent.id, selected)).rejects.toMatchObject({
      code: "HISTORY_INTENT_CONFLICT",
    });
  });

  test("configured snapshots cannot retag a binding while its persisted handle stays unchanged", async () => {
    const selected = {
      kind: "configured-home" as const,
      provider: "codex" as const,
      home: path.join(tmpDir, "profile"),
      sqliteHome: path.join(tmpDir, "db"),
    };
    const binding = {
      origin: "created" as const,
      registration: "registered" as const,
      sessionId: "old",
      storage: selected,
    };
    const agent = createManagedAgent({
      id: "binding-only-conflict",
      provider: "codex-work",
      providerHistory: binding,
      persistence: { provider: "codex-work", sessionId: "old" },
    });
    await storage.applySnapshot(agent);
    const canonical = await new AgentStorage(storagePath, logger).get(agent.id);
    // Exact helper counterexample: its handle stays old while only incoming metadata changes.
    expect(() =>
      preserveSnapshotHistoryBinding(
        binding,
        { ...binding, sessionId: "new" },
        { sessionId: "old" },
      ),
    ).toThrow("bound-session-id-changed");
    for (const [incoming, reason] of [
      [{ ...binding, sessionId: "new" }, "bound-session-id-changed"],
      [{ ...binding, origin: "imported" as const }, "snapshot-origin-changed"],
      [{ ...binding, registration: "intent" as const }, "snapshot-registration-regressed"],
    ] as const) {
      await expect(
        storage.applySnapshot({ ...agent, providerHistory: incoming }),
      ).rejects.toMatchObject({ reason });
      expect(await new AgentStorage(storagePath, logger).get(agent.id)).toEqual(canonical);
    }
    // An older unknown-ID observation cannot clear the established canonical ID.
    await storage.applySnapshot({ ...agent, providerHistory: { ...binding, sessionId: null } });
    expect((await new AgentStorage(storagePath, logger).get(agent.id))?.providerHistory).toEqual(
      binding,
    );
  });

  test("configured intent registration binds only the actual handle and preserves initial provenance", async () => {
    const selected = {
      kind: "configured-home" as const,
      provider: "codex" as const,
      home: path.join(tmpDir, "profile"),
      sqliteHome: path.join(tmpDir, "db"),
    };
    const initial = {
      origin: "created" as const,
      registration: "intent" as const,
      sessionId: null,
      storage: selected,
    };
    const agent = createManagedAgent({ id: "canonical-registration", provider: "codex-work" });
    const record = {
      ...toStoredAgentRecord(agent),
      persistence: undefined,
      providerHistory: initial,
    };
    await storage.reserveHistoryIntent(record);
    for (const [incoming, persistence, reason] of [
      [
        { ...initial, registration: "registered" as const, sessionId: "new" },
        { provider: "codex-work", sessionId: "old" },
        "bound-session-id-changed",
      ],
      [
        { ...initial, registration: "registered" as const, sessionId: "new" },
        undefined,
        "snapshot-registration-without-handle",
      ],
      [
        { ...initial, registration: "registered" as const, origin: "imported" as const },
        { provider: "codex-work", sessionId: "actual" },
        "snapshot-origin-changed",
      ],
      [
        { ...initial, sessionId: "actual" },
        { provider: "codex-work", sessionId: "actual" },
        "snapshot-intent-id-changed",
      ],
    ] as const) {
      await expect(
        storage.applySnapshot({
          ...agent,
          providerHistory: incoming,
          persistence: persistence ?? null,
        }),
      ).rejects.toMatchObject({ reason });
      const reloaded = new AgentStorage(storagePath, logger);
      expect(await reloaded.get(agent.id)).toBeNull();
      expect(
        (await reloaded.get(agent.id, { includeHistoryIntents: true }))?.providerHistory,
      ).toEqual(initial);
    }
    // Registration can see the native handle after its initial binding observation (Codex
    // getRuntimeInfo creates the first thread); the queued handle supplies the canonical ID.
    await storage.applySnapshot({
      ...agent,
      providerHistory: { ...initial, registration: "registered" },
      persistence: { provider: "codex-work", sessionId: "actual" },
    });
    const registered = { ...initial, registration: "registered", sessionId: "actual" };
    expect((await new AgentStorage(storagePath, logger).get(agent.id))?.providerHistory).toEqual(
      registered,
    );
    await storage.applySnapshot({
      ...agent,
      providerHistory: { ...initial, registration: "registered", sessionId: "actual" },
      persistence: { provider: "codex-work", sessionId: "actual" },
    });
    expect((await storage.get(agent.id))?.providerHistory).toEqual(registered);
  });

  test.each(["null", "missing"] as const)(
    "configured snapshot with %s persistence cannot erase the resumable handle",
    async (absence) => {
      const binding = {
        origin: "imported" as const,
        registration: "registered" as const,
        sessionId: "native-resumable",
        storage: {
          kind: "configured-home" as const,
          provider: "codex" as const,
          home: path.join(tmpDir, "profile"),
          sqliteHome: path.join(tmpDir, "db"),
        },
      };
      const handle = {
        provider: "codex-work",
        sessionId: "native-resumable",
        nativeHandle: "native-resumable",
        metadata: { cwd: tmpDir, provider: "codex-work" },
      };
      const agent = createManagedAgent({
        id: `missing-handle-${absence}`,
        provider: "codex-work",
        providerHistory: binding,
        persistence: handle,
        workspaceId: "original-workspace",
      });
      await storage.applySnapshot(agent);
      const before = await new AgentStorage(storagePath, logger).get(agent.id);
      const snapshot = { ...agent, persistence: null, updatedAt: new Date("2026-01-01T00:00:00Z") };
      if (absence === "missing") Reflect.deleteProperty(snapshot, "persistence");
      await expect(storage.applySnapshot(snapshot)).rejects.toMatchObject({
        reason: "bound-session-handle-missing",
      });
      const restarted = new AgentStorage(storagePath, logger);
      const reloaded = await restarted.get(agent.id);
      expect(reloaded).toEqual(before);
      expect(reloaded?.persistence).toEqual(handle);
      expect(reloaded?.providerHistory).toEqual(binding);
      if (!reloaded) throw new Error("Expected resumable record after reload");
      expect(buildStoredAgentPayload(reloaded, ["codex-work"]).persistence?.sessionId).toBe(
        "native-resumable",
      );
      expect(await restarted.listByProviderSession("codex-work", "native-resumable")).toMatchObject(
        [{ id: agent.id, workspaceId: "original-workspace", persistence: handle }],
      );
    },
  );

  test.each(["legacy", "unverified"] as const)(
    "%s snapshots retain existing missing-handle semantics",
    async (kind) => {
      const binding =
        kind === "unverified"
          ? {
              origin: "created" as const,
              registration: "registered" as const,
              sessionId: "native",
              storage: { kind: "unverified" as const, provider: "codex" as const, home: tmpDir },
            }
          : undefined;
      const agent = createManagedAgent({
        id: `ordinary-${kind}`,
        provider: "codex",
        providerHistory: binding,
        persistence: { provider: "codex", sessionId: "native" },
      });
      await storage.applySnapshot(agent);
      await storage.applySnapshot({ ...agent, persistence: null });
      const reloaded = await new AgentStorage(storagePath, logger).get(agent.id);
      expect(reloaded?.persistence).toBeNull();
      expect(reloaded?.providerHistory).toEqual(binding);
    },
  );

  test("queued reservation returns the original legacy record without adopting new provenance", async () => {
    const record = toStoredAgentRecord(createManagedAgent({ id: "legacy-selection" }));
    record.persistence = undefined;
    await storage.upsert(record);
    const proposed = {
      ...record,
      workspaceId: "different",
      providerHistory: {
        origin: "created" as const,
        registration: "intent" as const,
        sessionId: null,
        storage: { kind: "unknown" as const },
      },
    };
    expect(await storage.reserveHistoryIntent(proposed)).toEqual(record);
    expect(await storage.get(record.id)).toEqual(record);
  });

  test("legacy records are never rewritten as Paseo-created history", async () => {
    const agent = createManagedAgent({ id: "history-legacy" });
    await storage.applySnapshot(agent);
    expect(
      (await new AgentStorage(storagePath, logger).get(agent.id))?.providerHistory,
    ).toBeUndefined();
  });

  test("applySnapshot persists configs and snapshot metadata", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-1",
        cwd: "/tmp/project",
        currentModeId: "coding",
        lifecycle: "idle",
        config: {
          title: "Initial title",
          modeId: "coding",
          model: "gpt-5.1",
          systemPrompt: "Be terse and explicit.",
          providerOptions: { allowedTools: ["Read"] },
          mcpServers: {
            paseo: {
              type: "stdio",
              command: "node",
              args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
            },
          },
        },
      }),
    );

    const records = await storage.list();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.provider).toBe("claude");
    expect(record.config?.modeId).toBe("coding");
    expect(record.config?.model).toBe("gpt-5.1");
    expect(record.config?.systemPrompt).toBe("Be terse and explicit.");
    expect(record.config?.mcpServers).toEqual({
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-stdio-socket-bridge-cli.mjs", "--socket", "/tmp/test.sock"],
      },
    });
    expect(record.lastModeId).toBe("coding");
    expect(record.lastStatus).toBe("idle");

    const reloaded = new AgentStorage(storagePath, logger);
    const [persisted] = await reloaded.list();
    expect(persisted.cwd).toBe("/tmp/project");
    expect(persisted.config?.providerOptions).toEqual({ allowedTools: ["Read"] });
  });

  test("applySnapshot stores and reloads featureValues when present", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-feature-values",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-feature-values");
    expect(record?.config?.featureValues).toEqual({ fast_mode: true });

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-feature-values");
    expect(persisted?.config?.featureValues).toEqual({ fast_mode: true });
    expect(buildSessionConfig(persisted!).featureValues).toEqual({ fast_mode: true });
  });

  test("applySnapshot keeps featureValues absent when they were never set", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-no-feature-values",
      }),
    );

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-no-feature-values");
    expect(persisted?.config?.featureValues).toBeUndefined();
    expect(buildSessionConfig(persisted!).featureValues).toBeUndefined();
  });

  test("buildConfigOverrides includes featureValues when present in stored config", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-resume-overrides",
        config: {
          featureValues: {
            fast_mode: true,
          },
        },
      }),
    );

    const record = await storage.get("agent-resume-overrides");
    expect(record).not.toBeNull();
    expect(buildConfigOverrides(record!)).toMatchObject({
      cwd: "/tmp/project",
      featureValues: {
        fast_mode: true,
      },
    });
  });

  test("applySnapshot preserves original createdAt timestamp", async () => {
    const agentId = "agent-created-at";
    const firstTimestamp = new Date("2025-01-01T00:00:00.000Z");
    await storage.applySnapshot(createManagedAgent({ id: agentId, createdAt: firstTimestamp }));

    const initialRecord = await storage.get(agentId);
    expect(initialRecord?.createdAt).toBe(firstTimestamp.toISOString());

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        createdAt: new Date("2025-02-01T00:00:00.000Z"),
        updatedAt: new Date("2025-02-01T00:00:00.000Z"),
        lifecycle: "running",
      }),
    );

    const updatedRecord = await storage.get(agentId);
    expect(updatedRecord?.createdAt).toBe(firstTimestamp.toISOString());
    expect(updatedRecord?.lastStatus).toBe("running");
  });

  test("applySnapshot preserves archivedAt (soft-delete) status", async () => {
    const agentId = "agent-archived";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
      }),
    );

    const archivedAt = "2025-01-03T00:00:00.000Z";
    const recordBeforeArchive = await storage.get(agentId);
    expect(recordBeforeArchive).not.toBeNull();
    await storage.upsert({ ...recordBeforeArchive!, archivedAt });

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      }),
    );

    const recordAfterSnapshot = await storage.get(agentId);
    expect(recordAfterSnapshot?.archivedAt).toBe(archivedAt);
  });

  test("stores titles independently of snapshots", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "agent-2",
        provider: "codex",
        cwd: "/tmp/second",
      }),
    );
    await storage.setTitle("agent-2", "Fix Login Bug");

    const current = await storage.get("agent-2");
    expect(current?.title).toBe("Fix Login Bug");

    const reloaded = new AgentStorage(storagePath, logger);
    const persisted = await reloaded.get("agent-2");
    expect(persisted?.title).toBe("Fix Login Bug");
  });

  test("setTitle throws when the agent record does not exist", async () => {
    await expect(storage.setTitle("missing-agent", "Impossible")).rejects.toThrow(
      "Agent missing-agent not found",
    );
  });

  test("applySnapshot accepts explicit title overrides", async () => {
    const agentId = "agent-override";
    await storage.applySnapshot(createManagedAgent({ id: agentId }), { title: "Provided Title" });

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Provided Title");
  });

  test("applySnapshot preserves custom titles while updating metadata", async () => {
    const agentId = "agent-3";
    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "idle",
        currentModeId: "plan",
      }),
    );
    await storage.setTitle(agentId, "Important Bug Fix");

    await storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        currentModeId: "build",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    const record = await storage.get(agentId);
    expect(record?.title).toBe("Important Bug Fix");
    expect(record?.lastModeId).toBe("build");
    expect(record?.lastStatus).toBe("running");
  });

  test("applySnapshot projects metadata after in-flight archival writes", async () => {
    const agentId = "agent-pending-write";
    await storage.applySnapshot(createManagedAgent({ id: agentId }));
    const initialRecord = await storage.get(agentId);
    expect(initialRecord).not.toBeNull();

    let releasePendingWrite: (() => void) | null = null;
    const pendingWrite = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });

    const storageInternals = storage as unknown as {
      pendingWrites: Map<string, Promise<void>>;
      cache: Map<string, unknown>;
    };
    storageInternals.pendingWrites.set(agentId, pendingWrite);

    const applySnapshotPromise = storage.applySnapshot(
      createManagedAgent({
        id: agentId,
        lifecycle: "running",
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      }),
    );

    storageInternals.cache.set(agentId, {
      ...initialRecord!,
      title: "Generated title",
      archivedAt: "2025-01-03T00:00:00.000Z",
    });
    releasePendingWrite?.();

    await applySnapshotPromise;
    const record = await storage.get(agentId);
    expect(record?.title).toBe("Generated title");
    expect(record?.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  });

  test("list returns all agents including internal ones", async () => {
    // Create a normal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "normal-agent",
        cwd: "/tmp/project",
      }),
    );

    // Create an internal agent
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Registry should return all agents - filtering is done at the manager level
    const records = await storage.list();
    expect(records).toHaveLength(2);
  });

  test("get returns internal agents by ID", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    const record = await storage.get("internal-agent");
    expect(record).not.toBeNull();
    expect(record?.internal).toBe(true);
  });

  test("queries agents by provider session and native handle", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "matching-session",
        provider: "codex",
        persistence: {
          provider: "codex",
          sessionId: "session-1",
          nativeHandle: "thread-1",
        },
      }),
    );
    await storage.applySnapshot(
      createManagedAgent({
        id: "other-session",
        provider: "codex",
        persistence: { provider: "codex", sessionId: "session-2" },
      }),
    );

    await expect(storage.listByProviderSession("codex", "session-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
    await expect(storage.listByProviderSession("codex", "thread-1")).resolves.toMatchObject([
      { id: "matching-session" },
    ]);
  });

  test("queries agents by workspace", async () => {
    await storage.applySnapshot(
      createManagedAgent({ id: "workspace-agent", workspaceId: "workspace-1" }),
    );
    await storage.applySnapshot(
      createManagedAgent({ id: "other-workspace-agent", workspaceId: "workspace-2" }),
    );

    await expect(storage.listByWorkspace("workspace-1")).resolves.toMatchObject([
      { id: "workspace-agent" },
    ]);
  });

  test("internal flag is persisted and reloaded", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "internal-agent",
        cwd: "/tmp/project",
        config: { internal: true },
      }),
      { internal: true },
    );

    // Reload the registry from disk
    const reloaded = new AgentStorage(storagePath, logger);
    const record = await reloaded.get("internal-agent");
    expect(record?.internal).toBe(true);

    // Registry returns all agents - filtering happens at manager level
    const records = await reloaded.list();
    expect(records).toHaveLength(1);
    expect(records[0]?.internal).toBe(true);
  });

  test("Windows drive-letter paths produce valid directory names", async () => {
    await storage.applySnapshot(
      createManagedAgent({
        id: "win-agent",
        cwd: "D:\\Users\\dev\\MyProject",
      }),
    );

    const record = await storage.get("win-agent");
    expect(record).not.toBeNull();

    // The persisted directory must not contain a colon (invalid on Windows)
    const dirs = readdirSync(storagePath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toContain(":");
    expect(dirs[0]).toBe("D-Users-dev-MyProject");
  });

  test("remove deletes all duplicate record files across project directories", async () => {
    const agentId = "agent-duplicate";

    // Create a valid record file in two different project directories to simulate
    // storage migrations/duplication. Only one copy will be referenced in-memory,
    // but deletion should remove *all* copies on disk.
    const recordA = await (async () => {
      await storage.applySnapshot(
        createManagedAgent({
          id: agentId,
          cwd: "/tmp/project-a",
          provider: "codex",
        }),
      );
      const record = await storage.get(agentId);
      expect(record).not.toBeNull();
      return record!;
    })();

    const projectDirB = path.join(storagePath, "tmp-project-b");
    await fs.mkdir(projectDirB, { recursive: true });
    const duplicatePathB = path.join(projectDirB, `${agentId}.json`);
    await fs.writeFile(
      duplicatePathB,
      JSON.stringify({ ...recordA, cwd: "/tmp/project-b" }, null, 2),
      "utf8",
    );

    // Force a reload so the registry has to discover from disk (and may choose either copy).
    const reloaded = new AgentStorage(storagePath, logger);
    const before = await reloaded.list();
    expect(before.map((r) => r.id)).toContain(agentId);

    await reloaded.remove(agentId);

    const hasAnyRecordFile = async () => {
      const projects = await fs
        .readdir(storagePath, { withFileTypes: true })
        .catch(() => [] as Awaited<ReturnType<typeof fs.readdir>>);
      const exists = await Promise.all(
        projects
          .filter((project) => project.isDirectory())
          .map(async (project) => {
            const candidate = path.join(storagePath, project.name, `${agentId}.json`);
            try {
              await fs.access(candidate);
              return true;
            } catch {
              return false;
            }
          }),
      );
      return exists.some((present) => present);
    };

    expect(await hasAnyRecordFile()).toBe(false);

    const afterReload = new AgentStorage(storagePath, logger);
    const after = await afterReload.list();
    expect(after.some((r) => r.id === agentId)).toBe(false);
  });
});

describe("configured Claude rewind commits", () => {
  let directory: string;
  let registry: AgentStorage;
  const log = createTestLogger();
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-claude-rewind-storage-"));
    registry = new AgentStorage(directory, log);
    await registry.applySnapshot(
      createManagedAgent({
        id: "guarded",
        provider: "claude-work",
        workspaceId: "original-workspace",
        persistence: { provider: "claude-work", sessionId: "old", nativeHandle: "old" },
        providerHistory: {
          origin: "imported",
          registration: "registered",
          sessionId: "old",
          storage: { kind: "configured-home", provider: "claude", home: directory + "/" },
        },
      }),
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await registry.flush();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const newHandle = { provider: "claude-work", sessionId: "new", nativeHandle: "new" };
  test("empty Claude registration and first snapshot publish atomically; failed write leaves hidden audit intent", async () => {
    await registry.update("guarded", (r) => ({
      ...r,
      persistence: null,
      providerHistory: {
        ...r.providerHistory!,
        origin: "created",
        registration: "intent",
        sessionId: null,
      },
    }));
    const intent = (await registry.get("guarded", { includeHistoryIntents: true }))!;
    const snapshot = createManagedAgent({
      id: "guarded",
      provider: "claude-work",
      persistence: null,
      providerHistory: { ...intent.providerHistory!, registration: "registered" },
    });
    const writer = vi
      .spyOn(
        registry as unknown as { writeRecord(record: StoredAgentRecord): Promise<void> },
        "writeRecord",
      )
      .mockRejectedValueOnce(new Error("fixture-registration-write-failed"));
    await expect(
      registry.applySnapshot(snapshot, { registerClaudeEmptyCreation: true }),
    ).rejects.toThrow("fixture-registration-write-failed");
    writer.mockRestore();
    expect(await new AgentStorage(directory, log).get("guarded")).toBeNull();
    expect(
      (await registry.get("guarded", { includeHistoryIntents: true }))?.providerHistory
        ?.registration,
    ).toBe("intent");
    await expect(registry.applySnapshot(snapshot)).rejects.toThrow(
      "snapshot-registration-without-handle",
    );
    await registry.applySnapshot(snapshot, { registerClaudeEmptyCreation: true });
    expect((await new AgentStorage(directory, log).get("guarded"))?.providerHistory).toMatchObject({
      origin: "created",
      registration: "registered",
      sessionId: null,
    });
  });
  test("bound empty recreation reuses exact record and rejects changed config, audience or provenance", async () => {
    await registry.update("guarded", (r) => ({
      ...r,
      persistence: null,
      launchEnv: { CLAUDE_CODE_ENTRYPOINT: "saved-explicit-env" },
      providerHistory: { ...r.providerHistory!, origin: "created", sessionId: null },
    }));
    const before = (await registry.get("guarded"))!;
    const request = {
      ...before,
      providerHistory: {
        ...before.providerHistory!,
        registration: "intent" as const,
        storage: { kind: "unknown" as const },
      },
    };
    expect(await registry.reserveHistoryIntent(request)).toEqual(before);
    for (const change of [
      { config: { ...before.config, model: "different" } },
      { launchEnv: { CLAUDE_CODE_ENTRYPOINT: "changed-env" } },
      { launchEnv: undefined },
      { cwd: "/other" },
      { workspaceId: "other" },
      { provider: "other" },
      { providerHistory: { ...request.providerHistory, origin: "imported" as const } },
    ]) {
      await expect(registry.reserveHistoryIntent({ ...request, ...change })).rejects.toThrow(
        "already has durable state",
      );
    }
    expect(await new AgentStorage(directory, log).get("guarded")).toEqual(
      normalizeStoredRecord(before),
    );
  });
  test("initial lazy handle binds once through canonical queue; snapshots cannot supply or clear it", async () => {
    await registry.update("guarded", (r) => ({
      ...r,
      persistence: null,
      providerHistory: { ...r.providerHistory!, origin: "created", sessionId: null },
    }));
    const empty = (await registry.get("guarded"))!;
    await expect(
      registry.applySnapshot(
        createManagedAgent({
          id: "guarded",
          provider: "claude-work",
          persistence: newHandle,
          providerHistory: { ...empty.providerHistory!, sessionId: "new" },
        }),
      ),
    ).rejects.toThrow("initial-handle-binding-required");
    await registry.commitClaudeInitialHandle({
      expected: empty,
      next: newHandle,
      onCommitted: () => {},
    });
    await expect(
      registry.commitClaudeInitialHandle({
        expected: empty,
        next: { ...newHandle, sessionId: "second", nativeHandle: "second" },
        onCommitted: () => {},
      }),
    ).rejects.toMatchObject({ code: "HISTORY_STORAGE_CONFLICT" });
    await expect(
      registry.applySnapshot(
        createManagedAgent({
          id: "guarded",
          provider: "claude-work",
          persistence: null,
          providerHistory: empty.providerHistory,
        }),
      ),
    ).rejects.toThrow("bound-session-handle-missing");
    expect((await new AgentStorage(directory, log).get("guarded"))?.persistence).toEqual(newHandle);
  });
  test.each(["imported", "fresh", "codex"])(
    "initial binding rejects %s authority",
    async (kind) => {
      await registry.update("guarded", (r) => ({
        ...r,
        persistence: null,
        claudeFreshRewind: kind === "fresh" ? { operationId: "pending" } : undefined,
        providerHistory: {
          ...r.providerHistory!,
          origin: kind === "imported" ? "imported" : "created",
          sessionId: null,
          storage:
            kind === "codex"
              ? {
                  kind: "configured-home",
                  provider: "codex",
                  home: directory,
                  sqliteHome: directory,
                }
              : r.providerHistory!.storage,
        },
      }));
      const expected = (await registry.get("guarded"))!;
      await expect(
        registry.commitClaudeInitialHandle({ expected, next: newHandle, onCommitted: () => {} }),
      ).rejects.toThrow("initial-handle-binding-conflict");
    },
  );
  test("storage union keeps Codex SQLite required and cross-provider observations incompatible", () => {
    const claude = {
      kind: "configured-home" as const,
      provider: "claude" as const,
      home: directory,
    };
    const codex = {
      kind: "configured-home" as const,
      provider: "codex" as const,
      home: directory,
      sqliteHome: directory,
    };
    expect(
      ProviderHistoryStorageSchema.safeParse({ ...codex, sqliteHome: undefined }).success,
    ).toBe(false);
    expect(
      ProviderHistoryStorageSchema.safeParse({ ...claude, sqliteHome: directory }).success,
    ).toBe(false);
    expect(sameHistoryStorage(claude, codex)).toBe(false);
    expect(() =>
      registerProviderHistory({
        binding: {
          origin: "created",
          registration: "registered",
          sessionId: "old",
          storage: claude,
        },
        sessionId: "old",
        storage: codex,
      }),
    ).toThrow("provider-storage-observation-conflict");
  });
  test("only explicit queued rewind advances ID and preserves all other canonical metadata", async () => {
    const before = (await registry.get("guarded"))!;
    const adopted = vi.fn();
    await registry.commitClaudeRewind({ expected: before, next: newHandle, onCommitted: adopted });
    const after = (await new AgentStorage(directory, log).get("guarded"))!;
    expect(after).toEqual(
      normalizeStoredRecord({
        ...before,
        persistence: newHandle,
        providerHistory: { ...before.providerHistory!, sessionId: "new" },
        runtimeInfo: before.runtimeInfo ? { ...before.runtimeInfo, sessionId: "new" } : undefined,
      }),
    );
    expect(adopted).toHaveBeenCalledTimes(1);
    await expect(
      registry.applySnapshot(
        createManagedAgent({
          id: "guarded",
          provider: "claude-work",
          persistence: before.persistence!,
          providerHistory: before.providerHistory,
        }),
      ),
    ).rejects.toThrow("bound-session-id-changed");
  });
  test("fresh intent survives ordinary snapshots/reload and is consumed only by exact operation", async () => {
    const before = (await registry.get("guarded"))!;
    await registry.commitClaudeRewind({
      expected: before,
      freshOperationId: "operation",
      onCommitted: () => {},
    });
    await registry.applySnapshot(
      createManagedAgent({
        id: "guarded",
        provider: "claude-work",
        persistence: before.persistence!,
        providerHistory: before.providerHistory,
      }),
    );
    const pending = (await registry.get("guarded"))!;
    expect((await new AgentStorage(directory, log).get("guarded"))?.claudeFreshRewind).toEqual({
      operationId: "operation",
    });
    expect(pending.claudeFreshRewind).toEqual({ operationId: "operation" });
    expect(pending.persistence?.sessionId).toBe("old");
    await expect(
      registry.commitClaudeRewind({
        expected: pending,
        next: newHandle,
        freshOperationId: "wrong",
        onCommitted: () => {},
      }),
    ).rejects.toThrow("rewind-handle-conflict");
    await registry.commitClaudeRewind({
      expected: pending,
      next: newHandle,
      freshOperationId: "operation",
      onCommitted: () => {},
    });
    const loaded = await new AgentStorage(directory, log).get("guarded");
    expect(loaded?.claudeFreshRewind).toBeUndefined();
    expect(loaded?.persistence).toEqual(newHandle);
  });
  test("CAS conflict preserves newer metadata and original resumable identity", async () => {
    const before = (await registry.get("guarded"))!;
    await registry.setTitle("guarded", "newer title");
    const adopt = vi.fn();
    await expect(
      registry.commitClaudeRewind({ expected: before, next: newHandle, onCommitted: adopt }),
    ).rejects.toThrow("rewind-canonical-record-changed");
    expect(adopt).not.toHaveBeenCalled();
    expect(await new AgentStorage(directory, log).get("guarded")).toMatchObject({
      title: "newer title",
      persistence: { sessionId: "old" },
    });
  });
  test("failed atomic record writer never adopts or overwrites the prior native identity", async () => {
    const before = (await registry.get("guarded"))!;
    const writer = vi
      .spyOn(
        registry as unknown as { writeRecord(record: StoredAgentRecord): Promise<void> },
        "writeRecord",
      )
      .mockRejectedValueOnce(new Error("fixture-record-write-failed"));
    const adopt = vi.fn();
    await expect(
      registry.commitClaudeRewind({ expected: before, next: newHandle, onCommitted: adopt }),
    ).rejects.toThrow("fixture-record-write-failed");
    writer.mockRestore();
    expect(adopt).not.toHaveBeenCalled();
    expect(await new AgentStorage(directory, log).get("guarded")).toEqual(
      normalizeStoredRecord(before),
    );
  });
  test("post-commit adoption failure reports committed disk identity", async () => {
    const before = (await registry.get("guarded"))!;
    await expect(
      registry.commitClaudeRewind({
        expected: before,
        next: newHandle,
        onCommitted: () => {
          throw new Error("fixture adoption error");
        },
      }),
    ).rejects.toThrow("rewind-committed-adoption-failed:new");
    expect(await new AgentStorage(directory, log).get("guarded")).toMatchObject({
      persistence: newHandle,
      providerHistory: { sessionId: "new", origin: "imported" },
    });
  });
  test.each(["codex", "foreign-handle"])(
    "refuses %s transition without weakening Codex snapshots",
    async (kind) => {
      if (kind === "codex") {
        const old = (await registry.get("guarded"))!;
        await registry.update("guarded", (r) => ({
          ...r,
          providerHistory: {
            ...old.providerHistory!,
            storage: {
              kind: "configured-home",
              provider: "codex",
              home: directory,
              sqliteHome: directory,
            },
          },
        }));
      }
      const before = (await registry.get("guarded"))!;
      await expect(
        registry.commitClaudeRewind({
          expected: before,
          next: kind === "codex" ? newHandle : { ...newHandle, provider: "other" },
          onCommitted: () => {},
        }),
      ).rejects.toThrow();
      expect(await new AgentStorage(directory, log).get("guarded")).toEqual(
        normalizeStoredRecord(before),
      );
    },
  );
});
