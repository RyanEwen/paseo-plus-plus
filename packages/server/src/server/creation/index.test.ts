import pino from "pino";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { CreationService, type CreationInput, type CreationAgentAttempt } from "./index.js";

const silentLogger = pino({ level: "silent" });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const workspace: WorkspaceDescriptorPayload = {
  id: "wks_0123456789abcdef",
  projectId: "project",
  projectDisplayName: "Project",
  projectRootPath: "/project",
  workspaceDirectory: "/project/worktree",
  projectKind: "git",
  workspaceKind: "worktree",
  name: "Worktree",
  status: "running",
  statusEnteredAt: null,
  activityAt: null,
  archivingAt: null,
  scripts: [],
};
const agent: AgentSnapshotPayload = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: workspace.id,
  provider: "codex",
  cwd: "/project/worktree",
  model: null,
  createdAt: "2026-09-11T00:00:00Z",
  updatedAt: "2026-09-11T00:00:00Z",
  lastUserMessageAt: null,
  status: "idle",
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  title: "Start once",
  labels: {},
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "creation-lifecycle-"));
  directories.push(directory);
  const service = new CreationService(directory, silentLogger);
  const provider = deferred();
  const ready = deferred();
  const calls: string[] = [];
  const input: CreationInput = {
    kind: "workspace",
    key: "submit-one",
    request: { source: "/project", prompt: "Start once" },
    workspaceId: workspace.id,
    agentId: agent.id,
    hasAgent: true,
    hasPrompt: true,
    exists: async () => false,
    provision: async () => {
      calls.push("workspace");
      return { workspace };
    },
    createAgent: async (_id, _workspace, onReady) => {
      await provider.promise;
      calls.push("agent");
      await onReady(agent);
      calls.push("prompt");
      return { agent, initialPromptStarted: true };
    },
  };
  const updates: CreationSnapshot[] = [];
  const observe = (snapshot: CreationSnapshot) => {
    updates.push(snapshot);
    if (snapshot.phase === "workspace_ready") ready.resolve();
  };
  return { directory, service, input, provider, ready, calls, updates, observe };
}

test("workspace readiness is observable before provider startup and duplicate requests join the same work", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  expect(f.calls).toEqual(["workspace"]);
  expect(f.updates.map((s) => s.phase)).toEqual(["accepted", "workspace_ready"]);
  expect(f.updates[0]).toMatchObject({ workspaceId: workspace.id, agentId: agent.id });
  const duplicate = f.service.create(f.input);
  f.provider.resolve();
  expect(await first).toMatchObject({ phase: "completed", error: null, workspace, agent });
  expect(await duplicate).toEqual(await first);
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(await first);
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
});

test("a confirmed pre-dispatch failure retries only that stage with the reserved IDs", async () => {
  const f = await fixture();
  let attempts = 0;
  f.input.createAgent = async (id, readyWorkspace, onReady, attempt) => {
    attempts++;
    expect(id).toBe(agent.id);
    expect(readyWorkspace).toEqual(workspace);
    expect(attempt.retryHistoryIntent).toBe(attempts === 2);
    attempt.acknowledgeManager(id);
    attempt.certifyHistoryIntentReservation(id, workspace.id);
    if (attempts === 1) throw new Error("session-open hook failed before dispatch");
    attempt.consumeHistoryRetry(id);
    attempt.markProviderDispatch(id);
    await onReady(agent);
    return { agent, initialPromptStarted: true };
  };
  expect(await f.service.create(f.input)).toMatchObject({
    phase: "failed",
    failedStage: "agent",
    outcomeUnknown: false,
    workspace,
  });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toMatchObject({
    phase: "completed",
    agent,
  });
  expect(f.calls).toEqual(["workspace"]);
  expect(attempts).toBe(2);
});

test("an uncertain prompt outcome never resends or removes its workspace and agent", async () => {
  const f = await fixture();
  let prompts = 0;
  f.input.createAgent = async (_id, _workspace, onReady) => {
    await onReady(agent);
    prompts++;
    throw new Error("connection lost after provider accepted prompt");
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({
    phase: "failed",
    failedStage: "prompt",
    outcomeUnknown: true,
    workspace,
    agent,
  });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
  expect(prompts).toBe(1);
});

test("conflicting intents and resource IDs cannot start more work", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  await expect(f.service.create({ ...f.input, request: { prompt: "changed" } })).rejects.toThrow(
    "workspace_request_key_conflict",
  );
  await expect(f.service.create({ ...f.input, key: "another-intent" })).rejects.toThrow(
    "workspace_id_conflict",
  );
  f.provider.resolve();
  expect(await first).toMatchObject({ phase: "completed", error: null });
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
});

test("late subscribers recover readiness and removing an observer cannot stop creation", async () => {
  const f = await fixture();
  const first = f.service.create(f.input, f.observe);
  await f.ready.promise;
  const updates: CreationSnapshot[] = [];
  const subscription = await f.service.subscribe("workspace", f.input.key, (snapshot) =>
    updates.push(snapshot),
  );
  expect(subscription.snapshot).toMatchObject({ phase: "workspace_ready", workspace });
  subscription.unsubscribe();
  f.provider.resolve();
  await first;
  expect(updates).toEqual([]);
  const completed = await new CreationService(f.directory, silentLogger).subscribe(
    "workspace",
    f.input.key,
    () => {},
  );
  expect(completed.snapshot).toMatchObject({ phase: "completed", agent, workspace });
  completed.unsubscribe();
});

test("omitted resource IDs are generated once and preserved on replay", async () => {
  const f = await fixture();
  f.input.workspaceId = undefined;
  f.input.agentId = undefined;
  f.input.provision = async (id) => ({ workspace: { ...workspace, id } });
  f.input.createAgent = async (id, createdWorkspace, onReady) => {
    const created = { ...agent, id, workspaceId: createdWorkspace!.id };
    await onReady(created);
    return { agent: created, initialPromptStarted: true };
  };
  const result = await f.service.create(f.input);
  expect(result.workspaceId).toMatch(/^wks_[a-f0-9]{16}$/);
  expect(result.agentId).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
});

test("restart after a committed agent without a prompt completes without recreating the agent", async () => {
  const f = await fixture();
  const recoveredDirectory = await mkdtemp(join(tmpdir(), "creation-checkpoint-"));
  directories.push(recoveredDirectory);
  f.input.hasPrompt = false;
  let starts = 0;
  f.input.createAgent = async (_id, _workspace, onReady) => {
    starts++;
    await onReady(agent);
    // Capture the durable state at the exact milestone a process could stop after.
    await cp(f.directory, recoveredDirectory, { recursive: true });
    return { agent, initialPromptStarted: false };
  };
  await f.service.create(f.input);
  const recovered = await new CreationService(recoveredDirectory, silentLogger).create(f.input);
  expect(recovered).toMatchObject({ phase: "completed", workspace, agent });
  expect(starts).toBe(1);
});

test("partial provisioning without a registered workspace is not repeated", async () => {
  const f = await fixture();
  let provisions = 0;
  f.input.provision = async () => {
    provisions++;
    await writeFile(join(f.directory, "partial-checkout"), "disk was changed");
    throw new Error("Git failed after creating the checkout");
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({ phase: "failed", failedStage: "workspace", outcomeUnknown: true });
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
  expect(provisions).toBe(1);
});

test.each(["pending", "completed"])(
  "imports a %s legacy agent receipt without creating another agent",
  async (state) => {
    const f = await fixture();
    const legacyDirectory = join(f.directory, "legacy");
    await mkdir(legacyDirectory);
    const request = { config: { cwd: "/project", provider: "codex" } };
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    await writeFile(
      join(legacyDirectory, `${hash(["create", "old-key"])}.json`),
      JSON.stringify({
        fingerprint: hash({ ...request, type: "create_agent_request" }),
        state,
        agentId: agent.id,
      }),
    );
    const input: CreationInput = {
      kind: "agent",
      key: "old-key",
      request,
      hasAgent: true,
      hasPrompt: false,
      exists: async () => true,
      readAgent: async () => agent,
      createAgent: async () => {
        throw new Error("Must not create again");
      },
    };
    const service = new CreationService(f.directory, silentLogger, undefined, legacyDirectory);
    await expect(
      service.create({ ...input, request: { config: { ...request.config, cwd: "/changed" } } }),
    ).rejects.toThrow("agent_request_key_conflict");
    expect(await service.create(input)).toMatchObject({ phase: "completed", agent });
    expect(await new CreationService(f.directory, silentLogger).create(input)).toMatchObject({
      phase: "completed",
      agent,
    });
  },
);

test("observer failures are logged without failing creation", async () => {
  const f = await fixture();
  const logs: unknown[] = [];
  const logger = pino(
    { level: "warn" },
    {
      write: (line) => {
        logs.push(JSON.parse(line));
      },
    },
  );
  const service = new CreationService(f.directory, logger);
  f.provider.resolve();
  const result = await service.create(f.input, () => {
    throw new Error("delivery failed");
  });
  expect(result.phase).toBe("completed");
  expect(f.calls).toEqual(["workspace", "agent", "prompt"]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      level: 40,
      kind: "workspace",
      idempotencyKey: f.input.key,
      phase: "workspace_ready",
      err: expect.objectContaining({ message: "delivery failed" }),
    }),
  );
});

async function readReceipt(directory: string) {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  const file = join(directory, files[0]);
  return { file, record: JSON.parse(await readFile(file, "utf8")) };
}

test("old failed agent receipts cannot launder missing dispatch proof through a new callback", async () => {
  const f = await fixture();
  f.input.createAgent = async () => {
    throw new Error("original failure evidence");
  };
  await f.service.create(f.input);
  const { file, record } = await readReceipt(f.directory);
  record.snapshot.outcomeUnknown = false;
  record.inFlight = null;
  delete record.preDispatchAgentFailure;
  await writeFile(file, JSON.stringify(record));
  let callbacks = 0;
  f.input.createAgent = async () => {
    callbacks++;
    throw new Error("must not enter manager");
  };
  for (let restart = 0; restart < 2; restart++) {
    expect(await new CreationService(f.directory, silentLogger).create(f.input)).toMatchObject({
      phase: "failed",
      failedStage: "agent",
      outcomeUnknown: true,
      error: "original failure evidence",
      workspace,
      workspaceId: workspace.id,
      agentId: agent.id,
    });
  }
  expect(callbacks).toBe(0);
  const durable = (await readReceipt(f.directory)).record;
  expect(durable.preDispatchAgentFailure).toBeUndefined();
  expect(durable.snapshot.outcomeUnknown).toBe(true);
  expect(f.calls).toEqual(["workspace"]);
});

test("known-unsent workspace failures remain retryable without agent proof", async () => {
  const f = await fixture();
  let provisions = 0;
  f.input.provision = async () => {
    if (++provisions === 1)
      throw Object.assign(new Error("missing source"), { code: "directory_not_found" });
    return { workspace };
  };
  expect(await f.service.create(f.input)).toMatchObject({
    failedStage: "workspace",
    outcomeUnknown: false,
  });
  f.provider.resolve();
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toMatchObject({
    phase: "completed",
    workspace,
    agent,
  });
  expect(provisions).toBe(2);
});

test.each(["dropped", "before-ack"])(
  "%s manager context never certifies pre-dispatch safety",
  async (mode) => {
    const f = await fixture();
    let callbacks = 0;
    f.input.createAgent = async (_id, _workspace, _onReady, attempt) => {
      callbacks++;
      if (mode === "before-ack")
        expect(() => attempt.markProviderDispatch(agent.id)).toThrow("not admitted");
      throw new Error("unclassified callback failure");
    };
    const result = await f.service.create(f.input);
    expect(result).toMatchObject({ failedStage: "agent", outcomeUnknown: true });
    expect((await readReceipt(f.directory)).record.preDispatchAgentFailure).toBeUndefined();
    expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
    expect(callbacks).toBe(1);
  },
);

test("safe restart retry joins once and dispatched uncertainty never grants a third callback", async () => {
  const f = await fixture();
  let callbacks = 0;
  let firstAttempt: CreationAgentAttempt | undefined;
  const entered = deferred();
  const release = deferred();
  f.input.createAgent = async (id, _workspace, _onReady, attempt) => {
    callbacks++;
    expect(() => attempt.acknowledgeManager("wrong-id")).toThrow("another agent ID");
    attempt.acknowledgeManager(id);
    expect(() => attempt.certifyHistoryIntentReservation("wrong-id", workspace.id)).toThrow(
      "another agent ID",
    );
    expect(() => attempt.certifyHistoryIntentReservation(id, "other-workspace")).toThrow(
      "not admitted",
    );
    attempt.certifyHistoryIntentReservation(id, workspace.id);
    expect(() => attempt.certifyHistoryIntentReservation(id, workspace.id)).toThrow("not admitted");
    expect(() => attempt.acknowledgeManager(id)).toThrow("already entered");
    expect(() => attempt.assertRetryPlacementAdmitted(id)).toThrow("not admitted");
    if (callbacks === 1) {
      firstAttempt = attempt;
      expect(() => attempt.consumeHistoryRetry(id)).toThrow("not admitted");
      throw new Error("safe hook failure");
    }
    expect(attempt.retryHistoryIntent).toBe(true);
    expect(() => attempt.consumeHistoryRetry("wrong-id")).toThrow("another agent ID");
    expect(() => attempt.markProviderDispatch("wrong-id")).toThrow("another agent ID");
    attempt.consumeHistoryRetry(id);
    expect(() => attempt.consumeHistoryRetry(id)).toThrow("not admitted");
    entered.resolve();
    await release.promise;
    attempt.markProviderDispatch(id);
    expect(() => attempt.markProviderDispatch(id)).toThrow("not admitted");
    throw new Error("SDK may have allocated a native resource");
  };
  await f.service.create(f.input);
  expect((await readReceipt(f.directory)).record.preDispatchAgentFailure).toBe(true);
  for (const act of [
    () => firstAttempt!.certifyHistoryIntentReservation(agent.id, workspace.id),
    () => firstAttempt!.resolveRetryWorkspaceId(agent.id),
    () => firstAttempt!.assertRetryPlacementAdmitted(agent.id),
    () => firstAttempt!.acknowledgeManager(agent.id),
    () => firstAttempt!.markProviderDispatch(agent.id),
    () => firstAttempt!.consumeHistoryRetry(agent.id),
  ])
    expect(act).toThrow("expired");
  const restarted = new CreationService(f.directory, silentLogger);
  const retry = restarted.create(f.input);
  try {
    await entered.promise;
    const durable = (await readReceipt(f.directory)).record;
    expect(durable.inFlight).toBe("agent");
    expect(durable.preDispatchAgentFailure).toBeUndefined();
    const joined = restarted.create(f.input);
    release.resolve();
    const result = await retry;
    expect(await joined).toEqual(result);
    expect(result).toMatchObject({ failedStage: "agent", outcomeUnknown: true });
    expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
    expect(callbacks).toBe(2);
    expect(f.calls).toEqual(["workspace"]);
    expect((await readReceipt(f.directory)).record.preDispatchAgentFailure).toBeUndefined();
  } finally {
    release.resolve();
    await retry;
  }
});

test("stale safe marker with in-flight work becomes unknown before callback admission", async () => {
  const f = await fixture();
  f.input.createAgent = async (id, _workspace, _onReady, attempt) => {
    attempt.acknowledgeManager(id);
    attempt.certifyHistoryIntentReservation(id, workspace.id);
    throw new Error("safe hook");
  };
  await f.service.create(f.input);
  const { file, record } = await readReceipt(f.directory);
  record.inFlight = "agent";
  await writeFile(file, JSON.stringify(record));
  let calls = 0;
  f.input.createAgent = async () => {
    calls++;
    throw new Error("not allowed");
  };
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toMatchObject({
    failedStage: "agent",
    outcomeUnknown: true,
  });
  expect(calls).toBe(0);
  expect((await readReceipt(f.directory)).record.preDispatchAgentFailure).toBeUndefined();
});

test("safe retry rechecks registered resources and exact request config and env", async () => {
  const f = await fixture();
  let calls = 0;
  f.input.request = { config: { model: "model-a" }, env: { ROUTE: "one" } };
  f.input.createAgent = async (id, _workspace, _onReady, attempt) => {
    calls++;
    attempt.acknowledgeManager(id);
    attempt.certifyHistoryIntentReservation(id, workspace.id);
    throw new Error("safe hook");
  };
  await f.service.create(f.input);
  const before = await readReceipt(f.directory);
  for (const request of [
    { config: { model: "model-b" }, env: { ROUTE: "one" } },
    { config: { model: "model-a" }, env: { ROUTE: "two" } },
  ])
    await expect(f.service.create({ ...f.input, request })).rejects.toThrow("request_key_conflict");
  f.input.exists = async (kind) => kind === "agent";
  await expect(f.service.create(f.input)).rejects.toThrow("agent_id_conflict");
  expect(calls).toBe(1);
  expect((await readReceipt(f.directory)).record).toEqual(before.record);
});

test("failed safe-receipt publication cannot grant retry authority after restart", async () => {
  const f = await fixture();
  let callbacks = 0;
  const rename = fs.rename;
  let failSafeWrite = false;
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
    if (failSafeWrite) {
      failSafeWrite = false;
      throw new Error("safe receipt write refused");
    }
    return rename(...args);
  });
  try {
    f.input.createAgent = async (id, _workspace, _onReady, attempt) => {
      callbacks++;
      attempt.acknowledgeManager(id);
      attempt.certifyHistoryIntentReservation(id, workspace.id);
      failSafeWrite = true;
      throw new Error("safe hook failure");
    };
    await expect(f.service.create(f.input)).rejects.toThrow("safe receipt write refused");
    const durable = (await readReceipt(f.directory)).record;
    expect(durable.inFlight).toBe("agent");
    expect(durable.preDispatchAgentFailure).toBeUndefined();
    const result = await new CreationService(f.directory, silentLogger).create(f.input);
    expect(result).toMatchObject({ failedStage: "agent", outcomeUnknown: true });
    expect(callbacks).toBe(1);
    expect((await readReceipt(f.directory)).record.preDispatchAgentFailure).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("manager entry without a successful exclusive reservation cannot certify another intention", async () => {
  const f = await fixture();
  let calls = 0;
  f.input.createAgent = async (id, _workspace, _onReady, attempt) => {
    calls++;
    attempt.acknowledgeManager(id);
    throw new Error("a hook or reservation failed before ownership");
  };
  const result = await f.service.create(f.input);
  expect(result).toMatchObject({ outcomeUnknown: true, failedStage: "agent" });
  expect((await readReceipt(f.directory)).record.preDispatchAgentFailure).toBeUndefined();
  expect(await new CreationService(f.directory, silentLogger).create(f.input)).toEqual(result);
  expect(calls).toBe(1);
});
