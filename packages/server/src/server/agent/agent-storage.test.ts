import { AgentAttentionObjectives } from "./attention/objectives.js";
import { buildStoredAgentPayload } from "./agent-projections.js";
import { WorkspaceAttention } from "./workspace-attention.js";
import { createPersistedWorkspaceRecord } from "../workspace-registry.js";
import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage, type StoredAgentRecord } from "./agent-storage.js";
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

  test.each([
    ["completed human", "idle", "human", false],
    ["human error", "error", "human", true],
    ["agent error", "error", "agent", false],
    ["old known error", "error", "missing", true],
    ["old known quiet error", "error", "missing-quiet", false],
    ["old known completed", "closed", "missing", false],
    ["legacy undefined", "closed", "unknown", undefined],
  ] as const)(
    "T59 queued read preserves audience/problem policy after reload: %s",
    async (_name, status, audience, expected) => {
      const timestamp = "2026-10-26T10:00:00.000Z";
      const ledger = new AgentAttentionObjectives();
      if (audience === "human")
        ledger.admit({ inputs: [{ kind: "human", requestId: "human-request" }] });
      if (audience === "agent")
        ledger.admit({
          inputs: [
            {
              kind: "agent",
              requestId: "worker-request",
              requester: { serverId: "host", agentId: "requester" },
            },
          ],
        });
      if (status !== "error") ledger.finish();
      await storage.applySnapshot(
        createManagedAgent({
          id: "read-agent",
          lifecycle: status,
          attention: {
            requiresAttention: true,
            attentionReason: status === "error" ? "error" : "finished",
            attentionTimestamp: new Date(timestamp),
          },
        }),
      );
      const record = await storage.get("read-agent");
      if (!record) throw new Error("Missing persisted fixture");
      const original = {
        ...record,
        ...(audience === "unknown" ? {} : { humanAttentionRequired: audience !== "missing-quiet" }),
        ...(audience === "human" || audience === "agent"
          ? { attentionObjectives: ledger.snapshot() }
          : {}),
        attentionMessage: "Explicit event override",
      };
      await storage.upsert(original);
      expect(await storage.clearAttentionIfUnchanged("read-agent", timestamp)).not.toBeNull();
      const loaded = await new AgentStorage(storagePath, logger).get("read-agent");
      if (!loaded) throw new Error("Cleared record missing after fresh load");
      expect(loaded).toMatchObject({
        requiresAttention: false,
        attentionReason: null,
        attentionTimestamp: null,
        attentionMessage: null,
      });
      expect(loaded.humanAttentionRequired).toBe(expected);
      expect(loaded.attentionObjectives).toEqual(original.attentionObjectives);
      expect(buildStoredAgentPayload(loaded, ["codex"]).humanAttentionRequired).toBe(expected);
    },
  );

  test.each(["newer", "permission", "archived", "internal"] as const)(
    "T59 refused queued clear preserves every domain field: %s",
    async (refusal) => {
      const timestamp = "2026-10-26T10:00:00.000Z";
      await storage.applySnapshot(
        createManagedAgent({
          id: "protected",
          lifecycle: "idle",
          attention: {
            requiresAttention: true,
            attentionReason: "finished",
            attentionTimestamp: new Date(timestamp),
          },
        }),
      );
      const record = await storage.get("protected");
      if (!record) throw new Error("Missing protected fixture");
      const ledger = new AgentAttentionObjectives();
      ledger.admit({ inputs: [{ kind: "human", requestId: "keep-obligation" }] });
      const protectedRecord = {
        ...record,
        humanAttentionRequired: true,
        attentionMessage: "Keep explicit override",
        attentionObjectives: ledger.snapshot(),
        ...(refusal === "permission" ? { attentionReason: "permission" as const } : {}),
        ...(refusal === "archived" ? { archivedAt: timestamp } : {}),
        ...(refusal === "internal" ? { internal: true } : {}),
      };
      await storage.upsert(protectedRecord);
      const beforeRecord = await new AgentStorage(storagePath, logger).get("protected");
      if (!beforeRecord) throw new Error("Protected fixture was not persisted");
      const directories = await fs.readdir(storagePath);
      expect(directories).toHaveLength(1);
      const directory = directories[0];
      if (!directory) throw new Error("Protected fixture directory is missing");
      const recordPath = path.join(storagePath, directory, "protected.json");
      const beforeBytes = await fs.readFile(recordPath);
      const oldTimestamp = refusal === "newer" ? "2026-10-26T09:59:59.000Z" : timestamp;
      expect(await storage.clearAttentionIfUnchanged("protected", oldTimestamp)).toBeNull();
      expect(await new AgentStorage(storagePath, logger).get("protected")).toEqual(beforeRecord);
      expect(await fs.readFile(recordPath)).toEqual(beforeBytes);
    },
  );

  test("T59 legacy workspace read keeps a later queued title and problem projection", async () => {
    const timestamp = "2026-10-26T10:00:00.000Z";
    await storage.applySnapshot(
      createManagedAgent({
        id: "legacy-read",
        lifecycle: "idle",
        attention: {
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: new Date(timestamp),
        },
      }),
    );
    const initial = await storage.get("legacy-read");
    if (!initial) throw new Error("Missing legacy fixture");
    await storage.upsert({ ...initial, workspaceId: "workspace", humanAttentionRequired: true });
    let continueRead!: () => void;
    let captured!: () => void;
    const held = new Promise<void>((resolve) => {
      continueRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const published: StoredAgentRecord[] = [];
    const attention = new WorkspaceAttention({
      manager: { getAgent: () => null, clearAgentAttention: async () => {} },
      storage: {
        get: async (id) => {
          const record = await storage.get(id);
          captured();
          await held;
          return record;
        },
        upsert: (record) => storage.upsert(record),
        clearAttentionIfUnchanged: (id, observed) =>
          storage.clearAttentionIfUnchanged(id, observed),
      },
      publishStored: async (record) => {
        published.push(record);
      },
    });
    const workspace = createPersistedWorkspaceRecord({
      workspaceId: "workspace",
      projectId: "project",
      cwd: "/repo",
      kind: "directory",
      displayName: "Workspace",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const capturedRecord = await storage.get("legacy-read");
    if (!capturedRecord) throw new Error("Missing captured legacy fixture");
    const cleared: string[] = [];
    const pending = attention.clear({
      workspace,
      agents: [buildStoredAgentPayload(capturedRecord, ["codex"])],
      onCleared: (id) => {
        cleared.push(id);
      },
    });
    try {
      await readStarted;
      const currentLedger = new AgentAttentionObjectives();
      currentLedger.admit({ inputs: [{ kind: "human", requestId: "still-owed" }] });
      await storage.upsert({
        ...capturedRecord,
        title: "Newer title",
        lastStatus: "error",
        lastError: "Retain error detail",
        attentionObjectives: currentLedger.snapshot(),
      });
      continueRead();
      await pending;
      const loaded = await new AgentStorage(storagePath, logger).get("legacy-read");
      expect(loaded).toMatchObject({
        title: "Newer title",
        lastStatus: "error",
        lastError: "Retain error detail",
        requiresAttention: false,
        humanAttentionRequired: true,
      });
      expect(cleared).toEqual(["legacy-read"]);
      const committed = await storage.get("legacy-read");
      if (!committed || !loaded) throw new Error("Committed legacy-read fixture is missing");
      expect(published).toEqual([committed]);
      const reloadedPayload = buildStoredAgentPayload(loaded, ["codex"]);
      expect(buildStoredAgentPayload(committed, ["codex"])).toEqual(reloadedPayload);
      expect(published.map((record) => buildStoredAgentPayload(record, ["codex"]))).toEqual([
        reloadedPayload,
      ]);
    } finally {
      continueRead();
    }
  });

  test("clearAttentionIfUnchanged preserves a newer event and permission attention", async () => {
    const oldTimestamp = "2026-10-21T12:00:00.000Z";
    const newTimestamp = "2026-10-21T12:00:01.000Z";
    await storage.applySnapshot(
      createManagedAgent({
        id: "receipt-agent",
        lifecycle: "idle",
        attention: {
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: new Date(newTimestamp),
        },
      }),
    );
    expect(await storage.clearAttentionIfUnchanged("receipt-agent", oldTimestamp)).toBeNull();
    expect((await storage.get("receipt-agent"))?.attentionTimestamp).toBe(newTimestamp);
    await storage.applySnapshot(
      createManagedAgent({
        id: "receipt-agent",
        lifecycle: "idle",
        attention: {
          requiresAttention: true,
          attentionReason: "permission",
          attentionTimestamp: new Date(newTimestamp),
        },
      }),
    );
    expect(await storage.clearAttentionIfUnchanged("receipt-agent", newTimestamp)).toBeNull();
    expect((await storage.get("receipt-agent"))?.requiresAttention).toBe(true);
  });

  test("clearAttentionIfUnchanged serializes with a newer stored write", async () => {
    const timestamp = "2026-10-21T12:00:00.000Z";
    await storage.applySnapshot(
      createManagedAgent({
        id: "receipt-agent",
        lifecycle: "idle",
        attention: {
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: new Date(timestamp),
        },
      }),
    );
    const current = await storage.get("receipt-agent");
    if (!current) throw new Error("Missing receipt agent");
    const newerTimestamp = "2026-10-21T12:00:01.000Z";
    const write = storage.upsert({ ...current, attentionTimestamp: newerTimestamp });
    const clear = storage.clearAttentionIfUnchanged("receipt-agent", timestamp);
    await write;
    expect(await clear).toBeNull();
    expect((await storage.get("receipt-agent"))?.attentionTimestamp).toBe(newerTimestamp);
    expect(
      (await storage.clearAttentionIfUnchanged("receipt-agent", newerTimestamp))?.requiresAttention,
    ).toBe(false);
    expect(
      (await new AgentStorage(storagePath, logger).get("receipt-agent"))?.requiresAttention,
    ).toBe(false);
  });

  test("snapshot operation null skips its write and commit callback", async () => {
    const agent = createManagedAgent({ id: "snapshot-null" });
    await storage.applySnapshot(agent);
    const before = await storage.get(agent.id);
    const persistedBefore = await new AgentStorage(storagePath, logger).get(agent.id);
    expect(persistedBefore?.id).toBe(agent.id);
    const resolveSnapshot = vi.fn(() => null);
    const onCommitted = vi.fn();
    await storage.applySnapshot(
      { ...agent, cwd: "/tmp/skipped-snapshot" },
      { operation: { resolveSnapshot, onCommitted } },
    );
    expect(resolveSnapshot).toHaveBeenCalledOnce();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(await storage.get(agent.id)).toEqual(before);
    expect(await new AgentStorage(storagePath, logger).get(agent.id)).toEqual(persistedBefore);
    await storage.applySnapshot({ ...agent, currentModeId: "after-skip" });
    expect((await storage.get(agent.id))?.lastModeId).toBe("after-skip");
  });

  test("snapshot operation deleting skips resolution and commit callback", async () => {
    const agent = createManagedAgent({ id: "snapshot-deleting" });
    await storage.applySnapshot(agent);
    const before = await storage.get(agent.id);
    const persistedBefore = await new AgentStorage(storagePath, logger).get(agent.id);
    expect(persistedBefore?.id).toBe(agent.id);
    const resolveSnapshot = vi.fn(() => ({ ...agent, cwd: "/tmp/deleted-snapshot" }));
    const onCommitted = vi.fn();
    storage.beginDelete(agent.id);
    await storage.applySnapshot(agent, { operation: { resolveSnapshot, onCommitted } });
    expect(resolveSnapshot).not.toHaveBeenCalled();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(await storage.get(agent.id)).toEqual(before);
    expect(await new AgentStorage(storagePath, logger).get(agent.id)).toEqual(persistedBefore);
    await storage.remove(agent.id);
    expect(await new AgentStorage(storagePath, logger).get(agent.id)).toBeNull();
  });

  test("snapshot operation wrong identity cannot write another agent", async () => {
    const first = createManagedAgent({ id: "snapshot-first" });
    const second = createManagedAgent({ id: "snapshot-second" });
    await storage.applySnapshot(first);
    await storage.applySnapshot(second);
    const beforeFirst = await storage.get(first.id);
    const beforeSecond = await storage.get(second.id);
    const persistedBefore = new AgentStorage(storagePath, logger);
    const persistedFirst = await persistedBefore.get(first.id);
    const persistedSecond = await persistedBefore.get(second.id);
    expect(persistedFirst?.id).toBe(first.id);
    expect(persistedSecond?.id).toBe(second.id);
    const onCommitted = vi.fn();
    await expect(
      storage.applySnapshot(first, {
        operation: {
          resolveSnapshot: () => ({ ...second, currentModeId: "wrong-writer" }),
          onCommitted,
        },
      }),
    ).rejects.toThrow("Snapshot resolver changed agent identity");
    expect(onCommitted).not.toHaveBeenCalled();
    expect(await storage.get(first.id)).toEqual(beforeFirst);
    expect(await storage.get(second.id)).toEqual(beforeSecond);
    const reloaded = new AgentStorage(storagePath, logger);
    expect(await reloaded.get(first.id)).toEqual(persistedFirst);
    expect(await reloaded.get(second.id)).toEqual(persistedSecond);
    await storage.applySnapshot({ ...first, currentModeId: "after-rejection" });
    expect((await storage.get(first.id))?.lastModeId).toBe("after-rejection");
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
