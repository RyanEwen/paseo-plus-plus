import {
  REQUESTER_LOST_FAILURE_MESSAGE,
  REQUESTER_LOST_PERMISSION_MESSAGE,
} from "./attention/coordinator.js";
import { expect, test, vi, onTestFinished, type Mock } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { writeJsonFileAtomic } from "../atomic-file.js";
import {
  ControlledInterruptSession,
  SessionRecordingAgentClient,
  SteeringTestSession,
  TestAgentClient,
  createControlledInterruptFixture,
  deferred,
  drainAsyncGenerator,
  logger,
} from "./test-utils/manager-fixtures.js";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { AgentManager, type AgentAttentionCallback } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { toAgentPayload } from "./agent-projections.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { deriveAgentStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { AgentAttentionPeer } from "@getpaseo/protocol/agent-attention";
import { respondToAgentPermission } from "./permission-response.js";
import { AgentAttentionObjectives } from "./attention/objectives.js";
import { AttentionObjectiveError } from "./attention/errors.js";
import {
  CodexAsyncQuestions,
  codexAsyncQuestionToTimeline,
} from "./providers/codex/async-questions.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentPersistenceHandle,
  AgentRunOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

/** Record every human attention notification the manager raises. */
function observeAttentionNotifications(manager: AgentManager): Mock<AgentAttentionCallback> {
  const notify = vi.fn<AgentAttentionCallback>();
  manager.setAgentAttentionCallback(notify);
  return notify;
}

/** The human was notified exactly once that `agentId` finished, with `message` (or none). */
function expectNotifiedOnce(
  notify: Mock<AgentAttentionCallback>,
  input: { agentId: string; message: string | undefined },
) {
  expect(notify).toHaveBeenCalledExactlyOnceWith({
    agentId: input.agentId,
    provider: "codex",
    reason: "finished",
    message: input.message,
  });
}

test.each([false, true])(
  "completion follows the accepted recipient even with parent label = %s",
  async (child) => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-audience-"));
    const manager = new AgentManager({ clients: { codex: new TestAgentClient() }, logger });
    const calls: string[] = [];
    manager.setAgentAttentionCallback(({ reason }) => calls.push(reason));
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
      labels: child ? { [PARENT_AGENT_ID_LABEL]: randomUUID() } : {},
    });
    onTestFinished(async () => {
      await manager.closeAgent(agent.id);
      rmSync(workdir, { recursive: true, force: true });
    });
    await manager.runAgent(agent.id, "routine result for another agent", {
      attention: [
        { kind: "agent", requestId: "agent-request", requester: { agentId: randomUUID() } },
      ],
    });
    const quietSnapshot = manager.getAgent(agent.id);
    if (!quietSnapshot) throw new Error("Agent should remain loaded");
    expect(toAgentPayload(quietSnapshot).humanAttentionRequired).toBe(false);
    expect(manager.getAgent(agent.id)?.attention.requiresAttention).toBe(false);
    expect(calls).toEqual([]);
    await manager.runAgent(agent.id, "a human asks for the result");
    expect(calls).toEqual(["finished"]);
    await manager.runAgent(agent.id, "another quiet agent request", {
      attention: [
        { kind: "agent", requestId: "agent-request-two", requester: { agentId: randomUUID() } },
      ],
    });
    expect(manager.getAgent(agent.id)?.attention.requiresAttention).toBe(true);
    expect(calls).toEqual(["finished"]);
  },
);

test("a self-escalating child keeps the reason, deduplicates, and rejects unrelated objectives", async () => {
  const fixture = await createControlledInterruptFixture({
    name: "child-attention",
    agentId: randomUUID(),
    turnId: "child-turn",
    interrupt: async (session) =>
      session.pushEvent({ type: "turn_canceled", provider: "codex", turnId: "child-turn" }),
  });
  onTestFinished(() => fixture.cleanup());
  const { manager, agentId, session } = fixture;
  const calls: Array<{ agentId: string; message?: string }> = [];
  manager.setAgentAttentionCallback((event) => calls.push(event));
  const running = drainAsyncGenerator(
    manager.streamAgent(agentId, "agent work", {
      attention: [
        { kind: "agent", requestId: "worker-objective", requester: { agentId: randomUUID() } },
      ],
    }),
  );
  await manager.waitForAgentRunStart(agentId);
  expect(
    await manager.requestHumanAttention({
      agentId,
      objectiveId: "worker-objective",
      reason: "Choose the account",
    }),
  ).toEqual({ notified: true });
  await manager.clearAgentAttention(agentId);
  expect(
    await manager.requestHumanAttention({
      agentId,
      objectiveId: "worker-objective",
      reason: "Choose the account",
    }),
  ).toEqual({ notified: false });
  await expect(
    manager.requestHumanAttention({ agentId, objectiveId: "another-task", reason: "no" }),
  ).rejects.toBeInstanceOf(AttentionObjectiveError);
  expect(calls).toEqual([expect.objectContaining({ agentId, message: "Choose the account" })]);
  expect(manager.getTimeline(agentId)).toContainEqual(
    expect.objectContaining({
      type: "tool_call",
      name: "request_human_attention",
      detail: { type: "plain_text", text: "Choose the account" },
    }),
  );
  session.pushEvent({ type: "turn_completed", provider: "codex", turnId: "child-turn" });
  await running;
  expect(calls).toHaveLength(1);
});

test.each(["available", "missing", "unknown"] as const)(
  "agent permission fallback requires verified requester loss: %s",
  async (availability) => {
    const fixture = await createControlledInterruptFixture({
      name: "requester-attention",
      agentId: randomUUID(),
      turnId: "permission-turn",
      interrupt: async (session) =>
        session.pushEvent({ type: "turn_canceled", provider: "codex", turnId: "permission-turn" }),
    });
    onTestFinished(() => fixture.cleanup());
    const { manager, session, agentId } = fixture;
    manager.setAttentionHost({
      serverId: "local",
      resolveRemoteRequester: async () => availability,
    });
    const calls: string[] = [];
    manager.setAgentAttentionCallback(({ agentId: attentionAgentId }) =>
      calls.push(attentionAgentId),
    );
    const running = drainAsyncGenerator(
      manager.streamAgent(agentId, "agent task", {
        attention: [
          {
            kind: "agent",
            requestId: "blocked-task",
            requester: { agentId: randomUUID(), serverId: "remote" },
          },
        ],
      }),
    );
    await manager.waitForAgentRunStart(agentId);
    session.pushEvent({
      type: "permission_requested",
      provider: "codex",
      turnId: "permission-turn",
      request: { id: "permission", provider: "codex", kind: "tool", name: "Deploy" },
    });
    // Event ingestion and any availability check run on the manager's existing queue.
    await vi.waitFor(() => expect(manager.getAgent(agentId)?.pendingPermissions.size).toBe(1));
    await manager.flush();
    const snapshot = manager.getAgent(agentId);
    if (!snapshot) throw new Error("Agent should remain loaded");
    expect(toAgentPayload(snapshot).humanAttentionRequired).toBe(availability === "missing");
    expect(calls).toHaveLength(availability === "missing" ? 1 : 0);
    session.pushEvent({ type: "turn_canceled", provider: "codex", turnId: "permission-turn" });
    await running;
  },
);

test.each(["closed", "wrong-peer", "wrong-token"])(
  "claimed %s continuation is rejected before provider dispatch while ordinary agent work still runs",
  async (invalid) => {
    const workdir = mkdtempSync(join(tmpdir(), "attention-claim-"));
    const client = new SessionRecordingAgentClient();
    const manager = new AgentManager({ clients: { codex: client }, logger });
    const objectives = new AgentAttentionObjectives();
    objectives.admit({ inputs: [{ kind: "human", requestId: "human-job" }], steering: false });
    objectives.declare("human-job", "waiting");
    const attention = objectives.outgoing({ recipient: { agentId: "worker" } });
    if (!attention?.requesterObjective) throw new Error("Expected a delegation link");
    const link = { ...attention.requesterObjective };
    if (invalid === "closed") {
      objectives.declare("human-job", "final");
      objectives.finish();
    }
    if (invalid === "wrong-token") link.token = "invalid";
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
      attentionObjectives: objectives.snapshot(),
    });
    onTestFinished(async () => {
      await manager.closeAgent(agent.id);
      rmSync(workdir, { recursive: true, force: true });
    });
    const session = client.sessions[0];
    if (!session) throw new Error("Expected created provider session");
    const start = vi.spyOn(session, "startTurn");
    await expect(
      manager.runAgent(agent.id, "unrelated output must not be forwarded", {
        attention: [
          {
            kind: "agent",
            requestId: "claimed-reply",
            requester: { agentId: invalid === "wrong-peer" ? "other" : "worker" },
            attention: { continuation: link },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(AttentionObjectiveError);
    expect(start).not.toHaveBeenCalled();
    expect(
      manager
        .getAttentionObjectives(agent.id)
        .objectives.some((entry) => entry.id === "claimed-reply"),
    ).toBe(false);
    await manager.runAgent(agent.id, "ordinary unrelated agent work", {
      attention: [{ kind: "agent", requestId: "ordinary", requester: { agentId: "worker" } }],
    });
    expect(start).toHaveBeenCalledTimes(1);
  },
);

test("objective closure during callback reservation persistence keeps the outcome deliverable", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "attention-reservation-fence-"));
  class BlockingStorage extends AgentStorage {
    blockNext = false;
    entered = deferred<void>();
    release = deferred<void>();
    override async applySnapshot(
      ...args: Parameters<AgentStorage["applySnapshot"]>
    ): Promise<void> {
      const block = this.blockNext;
      this.blockNext = false;
      await super.applySnapshot(...args);
      if (block) {
        this.entered.resolve();
        await this.release.promise;
      }
    }
  }
  const storage = new BlockingStorage(join(workdir, "agents"), logger);
  const session = new ControlledInterruptSession(
    { provider: "codex", cwd: workdir },
    "human-turn",
    async (current) =>
      current.pushEvent({ type: "turn_canceled", provider: "codex", turnId: "human-turn" }),
  );
  const client = new (class extends TestAgentClient {
    override async createSession(): Promise<AgentSession> {
      return session;
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  manager.setAttentionHost({ serverId: "origin", resolveRemoteRequester: async () => "unknown" });
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  onTestFinished(async () => {
    storage.release.resolve();
    await manager.closeAgent(agent.id);
    await manager.flush();
    rmSync(workdir, { recursive: true, force: true });
  });
  const running = drainAsyncGenerator(
    manager.streamAgent(agent.id, "Human task", { clientMessageId: "human-job" }),
  );
  await manager.waitForAgentRunStart(agent.id);
  const peer = { agentId: randomUUID(), serverId: "target" };
  const attention = await manager.prepareAttentionMessage({ agentId: agent.id, recipient: peer });
  if (!attention?.requesterObjective) throw new Error("Expected request link");
  await manager.flush();
  storage.blockNext = true;
  const link = attention.requesterObjective;
  const reserving = manager.reserveAttentionCallback({
    agentId: agent.id,
    peer,
    link,
    deliveryId: "delivery",
    outcome: {
      id: "outcome",
      requestId: link.requestId,
      requester: { agentId: agent.id, serverId: "origin" },
      acceptedTurnId: "worker-turn",
      kind: "finished",
      lastMessage: "Worker response",
      error: null,
    },
  });
  await storage.entered.promise;
  session.pushEvent({ type: "turn_completed", provider: "codex", turnId: "human-turn" });
  await vi.waitFor(() => expect(manager.getAttentionObjectives(agent.id).objectives).toEqual([]));
  storage.release.resolve();
  await expect(reserving).resolves.toMatchObject({ status: "reserved" });
  await running;
});

/** Real lifecycle/storage fixture whose provider turns finish only through explicit SDK events. */
/** Builds a provider session for the `index`-th session this client creates or resumes. */
interface RecordingSessionHooks<Session extends AgentSession> {
  create(config: AgentSessionConfig, index: number): Session;
  /** Omit to keep TestAgentClient's own resume behaviour. */
  resume?(
    handle: AgentPersistenceHandle,
    config: Partial<AgentSessionConfig>,
    index: number,
  ): Session;
}

/** A test client that records every provider session it creates or resumes, in order. */
class RecordingAgentClient<Session extends AgentSession> extends TestAgentClient {
  readonly sessions: Session[] = [];
  readonly resumedHandles: AgentPersistenceHandle[] = [];

  constructor(private readonly hooks: RecordingSessionHooks<Session>) {
    super();
  }

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = this.hooks.create(config, this.sessions.length);
    this.sessions.push(session);
    return session;
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    if (!this.hooks.resume) {
      return super.resumeSession(handle, config);
    }
    this.resumedHandles.push(handle);
    const session = this.hooks.resume(handle, config ?? {}, this.sessions.length);
    this.sessions.push(session);
    return session;
  }
}

/**
 * A manager over real storage whose provider sessions are recorded, so each created agent comes
 * back with the exact session behind it. Cleans up the manager, storage and directory.
 */
function createRecordingClientFixture<Session extends AgentSession>(input: {
  directoryPrefix: string;
  hooks: (workdir: string) => RecordingSessionHooks<Session>;
  storageOptions?: ConstructorParameters<typeof AgentStorage>[2];
  timelineStore?: InMemoryAgentTimelineStore;
}) {
  const workdir = mkdtempSync(join(tmpdir(), input.directoryPrefix));
  const storage = new AgentStorage(join(workdir, "agents"), logger, input.storageOptions);
  const client = new RecordingAgentClient(input.hooks(workdir));
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    ...(input.timelineStore ? { timelineStore: input.timelineStore } : {}),
    logger,
  });
  onTestFinished(async () => {
    for (const agent of manager.listAgents()) {
      await manager.closeAgent(agent.id);
    }
    await manager.flush();
    await storage.flush();
    rmSync(workdir, { recursive: true, force: true });
  });
  return {
    workdir,
    storage,
    client,
    manager,
    /** Create an agent and return it with the provider session it was given. */
    async createAgent(title?: string, labels?: Record<string, string>) {
      const index = client.sessions.length;
      const agent = await manager.createAgent(
        { provider: "codex", cwd: workdir, ...(title === undefined ? {} : { title }) },
        undefined,
        { workspaceId: undefined, labels },
      );
      const session = client.sessions[index];
      if (!session) {
        throw new Error("Expected this agent's actual controlled provider session");
      }
      return { id: agent.id, session };
    },
  };
}

/** Controlled-interrupt sessions that cancel their turn when interrupted. */
function controlledInterruptSession(config: AgentSessionConfig, index: number) {
  return new ControlledInterruptSession(config, `attention-turn-${index + 1}`, async (current) =>
    current.pushEvent({ type: "turn_canceled", provider: "codex", turnId: current.turnId }),
  );
}

function createAttentionRegressionFixture(name: string) {
  const fixture = createRecordingClientFixture({
    directoryPrefix: `agent-attention-${name}-`,
    storageOptions: { writeRecordFile: recordWrites.write },
    hooks: (workdir) => ({
      create: controlledInterruptSession,
      resume: (handle, config, index) => {
        const session = controlledInterruptSession(
          { ...config, provider: "codex", cwd: config.cwd ?? workdir },
          index,
        );
        session.describePersistence = () => handle;
        return session;
      },
    }),
  });
  return {
    manager: fixture.manager,
    storage: fixture.storage,
    createAgent: (title: string) => fixture.createAgent(title),
  };
}

/** Wait for acceptance; actual I/O gates may retain queued writes until the test releases them. */
async function startAttentionRegressionTurn(input: {
  manager: AgentManager;
  agentId: string;
  options: AgentRunOptions;
  flush?: boolean;
  /** Observe the real SDK start before callers manually emit this turn's terminal. */
  nativeStart?: { session: AgentSession; turnId: string };
}) {
  const started = deferred<void>();
  const unsubscribe = input.manager.subscribe(
    (event) => {
      if (event.type === "agent_stream" && event.event.type === "turn_started") started.resolve();
    },
    { agentId: input.agentId, replayState: false },
  );
  let nativeStarted: Promise<void> | undefined;
  let unsubscribeNative: (() => void) | undefined;
  if (input.nativeStart) {
    const { session, turnId } = input.nativeStart;
    const observed = deferred<void>();
    nativeStarted = observed.promise;
    unsubscribeNative = session.subscribe((event) => {
      if (event.type === "turn_started" && event.turnId === turnId) observed.resolve();
    });
  }
  const running = input.manager.runAgent(
    input.agentId,
    "Exercise the accepted objective",
    input.options,
  );
  // Observe early rejections until the case explicitly asserts its terminal result.
  void running.catch(() => undefined);
  try {
    await input.manager.waitForAgentRunStart(input.agentId);
    await started.promise;
    if (nativeStarted) await nativeStarted;
    if (input.flush !== false) await input.manager.flush();
  } finally {
    unsubscribe();
    unsubscribeNative?.();
  }
  return { running };
}

/**
 * Start a human objective on the requester, mark it waiting, and delegate it to the recipient.
 * Returns the delegation, its exact request link and the requester's peer identity.
 */
async function delegateFromHumanObjective(input: {
  manager: AgentManager;
  requesterId: string;
  recipientId: string;
  objectiveId: string;
}) {
  const { manager, requesterId, objectiveId } = input;
  await startAttentionRegressionTurn({
    manager,
    agentId: requesterId,
    options: { clientMessageId: objectiveId },
  });
  await manager.reportObjectiveStatus({
    agentId: requesterId,
    objectiveId,
    disposition: "waiting",
  });
  const attention = await manager.prepareAttentionMessage({
    agentId: requesterId,
    recipient: { agentId: input.recipientId },
  });
  if (!attention?.requesterObjective) {
    throw new Error("Expected the exact delegated request");
  }
  return {
    attention,
    link: attention.requesterObjective,
    requesterPeer: manager.attentionRequester(requesterId),
  };
}

test.each(["human", "agent"] as const)(
  "permission terminal overlap for %s retains the accepted completion",
  async (audience) => {
    const fixture = createAttentionRegressionFixture(`permission-overlap-${audience}`);
    const { manager, storage } = fixture;
    const requester = await fixture.createAgent("Requester");
    const worker = await fixture.createAgent("Worker");
    const notify = observeAttentionNotifications(manager);
    const { attention, link, requesterPeer } = await delegateFromHumanObjective({
      manager,
      requesterId: requester.id,
      recipientId: worker.id,
      objectiveId: "human-job",
    });
    const options: AgentRunOptions =
      audience === "human"
        ? { clientMessageId: "human-worker-job" }
        : {
            clientMessageId: link.requestId,
            attention: [
              { kind: "agent", requestId: link.requestId, requester: requesterPeer, attention },
            ],
          };
    const { running } = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      options,
      nativeStart: { session: worker.session, turnId: worker.session.turnId },
    });
    worker.session.pushEvent({
      type: "permission_requested",
      provider: "codex",
      turnId: worker.session.turnId,
      request: { id: "overlap-permission", provider: "codex", kind: "tool", name: "Run" },
    });
    await manager.flush();
    expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(1);
    expect(notify.mock.calls.map(([event]) => event.reason)).toEqual(
      audience === "human" ? ["permission"] : [],
    );
    await manager.clearAgentAttention(worker.id);
    notify.mockClear();

    const responseEntered = deferred<void>();
    const releaseResponse = deferred<void>();
    const providerResponse = vi
      .spyOn(worker.session, "respondToPermission")
      .mockImplementation(async () => {
        responseEntered.resolve();
        await releaseResponse.promise;
      });
    const responding = manager.respondToPermission(worker.id, "overlap-permission", {
      behavior: "allow",
    });
    try {
      await responseEntered.promise;
      worker.session.pushEvent({
        type: "permission_resolved",
        provider: "codex",
        turnId: worker.session.turnId,
        requestId: "overlap-permission",
        resolution: { behavior: "allow" },
      });
      worker.session.pushEvent({
        type: "timeline",
        provider: "codex",
        turnId: worker.session.turnId,
        item: { type: "assistant_message", text: "Exact final response after permission" },
      });
      worker.session.pushEvent({
        type: "turn_completed",
        provider: "codex",
        turnId: worker.session.turnId,
      });
      // Ingest the real terminal event while the provider response promise is still held.
      await running;
      await manager.flush();
      expect(manager.getAgent(worker.id)?.lifecycle).toBe("idle");
      expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(0);
    } finally {
      releaseResponse.resolve();
      await responding;
      providerResponse.mockRestore();
    }
    await manager.flush();
    expect(await manager.getLastAssistantMessage(worker.id)).toBe(
      "Exact final response after permission",
    );
    expect(
      notify.mock.calls.map(([event]) => ({ agentId: event.agentId, reason: event.reason })),
    ).toEqual(audience === "human" ? [{ agentId: worker.id, reason: "finished" }] : []);
    const snapshot = manager.getAgent(worker.id);
    if (!snapshot) throw new Error("Expected the completed worker to remain loaded");
    expect(toAgentPayload(snapshot).humanAttentionRequired).toBe(audience === "human");

    if (audience === "agent") {
      const record = await storage.get(worker.id);
      expect(record?.attentionObjectives?.requests?.records).toEqual([
        expect.objectContaining({
          link,
          requester: requesterPeer,
          turnId: worker.session.turnId,
          active: false,
          outcomes: [
            expect.objectContaining({ kind: "permission" }),
            expect.objectContaining({
              kind: "finished",
              requestId: link.requestId,
              acceptedTurnId: worker.session.turnId,
              lastMessage: "Exact final response after permission",
              error: null,
            }),
          ],
        }),
      ]);
      const query = { link, requester: requesterPeer };
      const signal = new AbortController().signal;
      const checkpoint = await manager.waitForAttentionOutcome({
        agentId: worker.id,
        query,
        signal,
      });
      if (!checkpoint) throw new Error("Expected the exact permission checkpoint");
      const finished = await manager.waitForAttentionOutcome({
        agentId: worker.id,
        query: { ...query, acknowledgeOutcomeId: checkpoint.id },
        signal,
      });
      if (!finished) throw new Error("Expected the exact finished outcome");
      expect(finished.id).not.toBe(checkpoint.id);
      expect(await manager.waitForAttentionOutcome({ agentId: worker.id, query, signal })).toEqual(
        finished,
      );
      expect(
        await manager.waitForAttentionOutcome({
          agentId: worker.id,
          query: { ...query, acknowledgeOutcomeId: finished.id },
          signal,
        }),
      ).toBeNull();
    }
  },
);

test.each(["permission", "error"] as const)(
  "archived requester rechecks %s without a new worker event",
  async (blocker) => {
    const fixture = createAttentionRegressionFixture(`requester-archive-${blocker}`);
    const { manager, storage } = fixture;
    const requester = await fixture.createAgent("Independent requester");
    const worker = await fixture.createAgent("Independent worker");
    const notify = observeAttentionNotifications(manager);
    const pushed = vi.spyOn(worker.session, "pushEvent");
    const { running } = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      nativeStart: { session: worker.session, turnId: worker.session.turnId },
      options: {
        attention: [
          {
            kind: "agent",
            requestId: "blocked-request",
            requester: manager.attentionRequester(requester.id),
          },
        ],
      },
    });
    if (blocker === "permission") {
      worker.session.pushEvent({
        type: "permission_requested",
        provider: "codex",
        turnId: worker.session.turnId,
        request: { id: "orphan-permission", provider: "codex", kind: "tool", name: "Deploy" },
      });
    } else {
      worker.session.pushEvent({
        type: "turn_failed",
        provider: "codex",
        turnId: worker.session.turnId,
        error: "Exact worker failure",
      });
      await expect(running).rejects.toThrow("Exact worker failure");
    }
    await manager.flush();
    if (blocker === "error") expect(manager.getAgent(worker.id)?.lifecycle).toBe("error");
    const before = manager.getAgent(worker.id);
    if (!before) throw new Error("Expected the blocked independent worker");
    expect(before.labels).not.toHaveProperty(PARENT_AGENT_ID_LABEL);
    const persistedRequester = await storage.get(requester.id);
    expect(persistedRequester).toMatchObject({ id: requester.id });
    expect(persistedRequester?.archivedAt).toBeUndefined();
    expect(toAgentPayload(before).humanAttentionRequired).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    const providerEventsBeforeArchive = pushed.mock.calls.length;

    const archived = await manager.archiveAgent(requester.id);
    await manager.flush();
    expect((await storage.get(requester.id))?.archivedAt).toBe(archived.archivedAt);
    expect(pushed).toHaveBeenCalledTimes(providerEventsBeforeArchive);
    const after = manager.getAgent(worker.id);
    if (!after) throw new Error("Archiving an independent requester must not archive its worker");
    const payload = toAgentPayload(after);
    expect(
      deriveAgentStateBucket({
        ...payload,
        pendingPermissionCount: payload.pendingPermissions.length,
      }),
    ).toBe(blocker === "permission" ? "needs_input" : "failed");
    expect(payload.humanAttentionRequired).toBe(true);
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      agentId: worker.id,
      provider: "codex",
      reason: "finished",
      message:
        blocker === "permission"
          ? REQUESTER_LOST_PERMISSION_MESSAGE
          : REQUESTER_LOST_FAILURE_MESSAGE,
    });
    await manager.flush();
    expect(notify).toHaveBeenCalledTimes(1);
    pushed.mockRestore();
  },
);

test("human escalation write failure retries once without losing the notification", async () => {
  const fixture = createAttentionRegressionFixture("escalation-write-failure");
  const { manager, storage } = fixture;
  const requester = await fixture.createAgent("Requester");
  const worker = await fixture.createAgent("Escalating worker");
  const notify = observeAttentionNotifications(manager);
  const { running } = await startAttentionRegressionTurn({
    manager,
    agentId: worker.id,
    options: {
      attention: [
        {
          kind: "agent",
          requestId: "retry-escalation",
          requester: manager.attentionRequester(requester.id),
        },
      ],
    },
  });
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
    "retry-escalation",
  ]);
  await storage.flush();
  const write = holdEscalationAtomicWrite(worker.id, "fail");
  const snapshotWrite = vi.spyOn(storage, "applySnapshot");
  const request = {
    agentId: worker.id,
    objectiveId: "retry-escalation",
    reason: "Choose the deployment account",
  };
  try {
    const first = manager.requestHumanAttention(request);
    void first.catch(() => undefined);
    await write.entered.promise;
    expect(notify).not.toHaveBeenCalled();
    write.release.resolve();
    await expect(first).rejects.toBe(write.failure);
    expect(snapshotWrite).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: true });
    expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: false });
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    write.release.resolve();
    snapshotWrite.mockRestore();
  }
  worker.session.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: worker.session.turnId,
  });
  await running;
  expect(notify).toHaveBeenCalledTimes(1);
});

/** Reproduce immediate plan approval through the public helper while its real refresh is held. */
async function createPermissionHandoffFixture(audience: "human" | "agent") {
  const fixture = createAttentionRegressionFixture(`plan-handoff-${audience}`);
  const { manager, storage } = fixture;
  const requester = await fixture.createAgent("Plan requester");
  const worker = await fixture.createAgent("Plan worker");
  const notify = observeAttentionNotifications(manager);
  const { attention, link, requesterPeer } = await delegateFromHumanObjective({
    manager,
    requesterId: requester.id,
    recipientId: worker.id,
    objectiveId: "handoff-source",
  });
  const objectiveId = audience === "human" ? "human-plan-job" : link.requestId;
  const options: AgentRunOptions =
    audience === "human"
      ? { clientMessageId: objectiveId }
      : {
          clientMessageId: objectiveId,
          attention: [
            { kind: "agent", requestId: objectiveId, requester: requesterPeer, attention },
          ],
        };
  const planTurnId = worker.session.turnId;
  const nextTurnId = `${planTurnId}-implementation`;
  const providerStart = vi
    .spyOn(worker.session, "startTurn")
    .mockResolvedValueOnce({ turnId: planTurnId })
    .mockResolvedValueOnce({ turnId: nextTurnId });
  const { running: planning } = await startAttentionRegressionTurn({
    manager,
    agentId: worker.id,
    options,
  });
  const followUpPrompt = "Implement the approved plan";
  const providerResponse = vi
    .spyOn(worker.session, "respondToPermission")
    .mockImplementation(async () => {
      // The adapter queues this resolution from approval, after its earlier plan terminal.
      worker.session.pushEvent({
        type: "permission_resolved",
        provider: "codex",
        requestId: "plan-approval",
        resolution: { behavior: "allow" },
      });
      return { followUpPrompt };
    });
  const refreshEntered = deferred<void>();
  const releaseRefresh = deferred<void>();
  const refresh = vi.spyOn(worker.session, "getAvailableModes").mockImplementationOnce(async () => {
    refreshEntered.resolve();
    await releaseRefresh.promise;
    return [];
  });
  const approval = deferred<void>();
  // Keep an early helper rejection observed until the test asserts its actual result.
  void approval.promise.catch(() => undefined);
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type !== "agent_stream" || event.event.type !== "permission_requested") return;
      void respondToAgentPermission({
        agentManager: manager,
        agentId: worker.id,
        requestId: event.event.request.id,
        response: { behavior: "allow" },
        logger,
      }).then(approval.resolve, approval.reject);
    },
    { agentId: worker.id, replayState: false },
  );
  onTestFinished(() => {
    releaseRefresh.resolve();
    unsubscribe();
    refresh.mockRestore();
    providerResponse.mockRestore();
    providerStart.mockRestore();
  });
  return {
    manager,
    storage,
    worker,
    notify,
    link,
    requesterPeer,
    objectiveId,
    planTurnId,
    nextTurnId,
    providerStart,
    providerResponse,
    audience,
    stopAutomaticApproval: unsubscribe,
    followUpPrompt,
    planning,
    approval,
    refreshEntered,
    releaseRefresh,
    queuePlanBoundary() {
      worker.session.pushEvent({
        type: "timeline",
        provider: "codex",
        turnId: planTurnId,
        item: { type: "assistant_message", text: "Proposed plan, not implementation output" },
      });
      // Match the adapter's single permission-then-terminal sequence. Approval happens on ingestion.
      worker.session.pushEvent({
        type: "permission_requested",
        provider: "codex",
        turnId: planTurnId,
        request: { id: "plan-approval", provider: "codex", kind: "plan", name: "Implement plan" },
      });
      worker.session.pushEvent({ type: "turn_completed", provider: "codex", turnId: planTurnId });
    },
  };
}

test.each(["human", "agent"] as const)(
  "permission handoff for %s finishes only after implementation",
  async (audience) => {
    const handoff = await createPermissionHandoffFixture(audience);
    const { manager, worker, storage, notify, objectiveId } = handoff;
    try {
      handoff.queuePlanBoundary();
      await handoff.refreshEntered.promise;
      await handoff.planning;
      await manager.flush();
      // Prove the risky ordering using actual ingestion, without a second plan terminal.
      expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(0);
      expect(manager.getAgent(worker.id)?.lifecycle).toBe("idle");
      expect(handoff.providerStart).toHaveBeenCalledTimes(1);
      expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([objectiveId]);
      expect(notify.mock.calls.map(([event]) => event.reason)).toEqual(
        audience === "human" ? ["permission"] : [],
      );
      if (audience === "agent") {
        expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
          expect.objectContaining({
            link: handoff.link,
            turnId: handoff.planTurnId,
            active: true,
            outcomes: [expect.objectContaining({ kind: "permission" })],
          }),
        ]);
      }
    } finally {
      handoff.releaseRefresh.resolve();
      // Settle the real helper during cleanup without hiding its result asserted below.
      await Promise.allSettled([handoff.approval.promise]);
    }
    await handoff.approval.promise;
    await manager.waitForAgentRunStart(worker.id);
    expect(handoff.providerStart).toHaveBeenNthCalledWith(
      2,
      handoff.followUpPrompt,
      expect.objectContaining({
        attention: [expect.objectContaining({ kind: "continuation", objectiveIds: [objectiveId] })],
      }),
    );
    expect(manager.getAgent(worker.id)?.activeTurnId).toBe(handoff.nextTurnId);
    expect(manager.getAttentionObjectives(worker.id)).toEqual({
      activeObjectiveIds: [objectiveId],
      objectives: [
        {
          id: objectiveId,
          audience:
            audience === "human"
              ? { kind: "human" }
              : { kind: "agent", requester: handoff.requesterPeer },
          disposition: "normal",
        },
      ],
    });
    // Codex publishes the next turn's actual prompt echo before its assistant output.
    publishImplementationTurn({
      session: worker.session,
      turnId: handoff.nextTurnId,
      prompt: handoff.followUpPrompt,
      echoMessageId: "implementation-prompt-echo",
    });
    await manager.flush();
    expect(manager.getTimeline(worker.id)).toContainEqual({
      type: "user_message",
      messageId: "implementation-prompt-echo",
      text: handoff.followUpPrompt,
    });
    expect(await manager.getLastAssistantMessage(worker.id)).toBe("Exact implementation result");
    expect(notify.mock.calls.map(([event]) => event.reason)).toEqual(
      audience === "human" ? ["permission", "finished"] : [],
    );
    const snapshot = manager.getAgent(worker.id);
    if (!snapshot) throw new Error("Expected the implementation worker to remain loaded");
    expect(toAgentPayload(snapshot).humanAttentionRequired).toBe(audience === "human");
    if (audience === "agent") {
      expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
        expect.objectContaining({
          link: handoff.link,
          requester: handoff.requesterPeer,
          turnId: handoff.nextTurnId,
          active: false,
          outcomes: [
            expect.objectContaining({ kind: "permission", acceptedTurnId: handoff.planTurnId }),
            expect.objectContaining({
              kind: "finished",
              acceptedTurnId: handoff.nextTurnId,
              requestId: handoff.link.requestId,
              lastMessage: "Exact implementation result",
              error: null,
            }),
          ],
        }),
      ]);
    }
  },
);

test("stale permission handoff cannot replace a newly accepted request", async () => {
  const handoff = await createPermissionHandoffFixture("agent");
  const { manager, worker, notify, storage } = handoff;
  let newRun: Awaited<ReturnType<typeof startAttentionRegressionTurn>> | undefined;
  try {
    handoff.queuePlanBoundary();
    await handoff.refreshEntered.promise;
    await handoff.planning;
    await manager.flush();
    newRun = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      options: { clientMessageId: "new-human-request" },
    });
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
      "new-human-request",
    ]);
  } finally {
    handoff.releaseRefresh.resolve();
    await Promise.allSettled([handoff.approval.promise]);
  }
  await expect(handoff.approval.promise).rejects.toBeInstanceOf(AttentionObjectiveError);
  expect(handoff.providerStart).toHaveBeenCalledTimes(2);
  expect(manager.getAgent(worker.id)?.activeTurnId).toBe(handoff.nextTurnId);
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
    "new-human-request",
  ]);
  expect(notify).not.toHaveBeenCalled();
  worker.session.pushEvent({
    type: "timeline",
    provider: "codex",
    turnId: handoff.nextTurnId,
    item: { type: "assistant_message", text: "New human request result" },
  });
  worker.session.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: handoff.nextTurnId,
  });
  if (!newRun) throw new Error("Expected the unrelated request to have been admitted");
  await newRun.running;
  await manager.flush();
  expectNotifiedOnce(notify, { agentId: worker.id, message: undefined });
  expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
    expect.objectContaining({
      link: handoff.link,
      active: false,
      outcomes: [
        expect.objectContaining({ kind: "permission", acceptedTurnId: handoff.planTurnId }),
        expect.objectContaining({
          kind: "canceled",
          acceptedTurnId: handoff.planTurnId,
          error: "Replaced by another accepted request",
          lastMessage: "Proposed plan, not implementation output",
        }),
      ],
    }),
  ]);
});

interface EscalationFaultFixtureInput {
  name: string;
  requesterPeer?: AgentAttentionPeer;
  nativeStart?: boolean;
}

/** Admit a real agent objective before any escalation fault is installed. */
async function createEscalationFaultFixture({
  name,
  requesterPeer,
  nativeStart = false,
}: EscalationFaultFixtureInput) {
  const fixture = createAttentionRegressionFixture(name);
  const requester = await fixture.createAgent("Escalation requester");
  const worker = await fixture.createAgent("Escalation worker");
  const notify = observeAttentionNotifications(fixture.manager);
  const requesterIdentity = requesterPeer ?? fixture.manager.attentionRequester(requester.id);
  const { running } = await startAttentionRegressionTurn({
    manager: fixture.manager,
    agentId: worker.id,
    options: {
      attention: [
        { kind: "agent", requestId: "escalation-objective", requester: requesterIdentity },
      ],
    },
    nativeStart: nativeStart
      ? { session: worker.session, turnId: worker.session.turnId }
      : undefined,
  });
  return {
    ...fixture,
    worker,
    notify,
    running,
    requesterIdentity,
    request: {
      agentId: worker.id,
      objectiveId: "escalation-objective",
      reason: "Choose the deployment account",
    },
  };
}

/** Hold one outer API acknowledgement, after the real storage queue has already released. */
function holdEscalationSnapshot(
  storage: AgentStorage,
  outcome: "fail-before-write" | "fail-after-write" | "succeed-after-write",
) {
  const entered = deferred<void>();
  const release = deferred<void>();
  const failure = new Error(`Injected escalation ${outcome}`);
  const applySnapshot = storage.applySnapshot.bind(storage);
  const spy = vi.spyOn(storage, "applySnapshot").mockImplementationOnce(async (...args) => {
    if (outcome !== "fail-before-write") await applySnapshot(...args);
    entered.resolve();
    await release.promise;
    if (outcome !== "succeed-after-write") throw failure;
  });
  onTestFinished(() => {
    release.resolve();
    spy.mockRestore();
  });
  return { entered, release, failure, spy };
}

/** Hold this worker's real atomic rename inside its storage queue, before the record commits. */
interface RecordWriteHold {
  agentId: string;
  outcome: "fail" | "succeed";
  entered: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<void>>;
  failure: Error;
}

/**
 * The durable record-write port of every attention regression fixture's storage. A test holds
 * or fails one agent's next commit explicitly instead of patching the file system.
 */
class RecordWriteGate {
  private readonly holds: RecordWriteHold[] = [];
  private readonly failures: Array<{ agentId: string; error: Error; failed(): void }> = [];
  private writeCount = 0;

  readonly write = async (path: string, record: StoredAgentRecord): Promise<void> => {
    this.writeCount += 1;
    const failure = this.take(this.failures, path);
    if (failure) {
      failure.failed();
      throw failure.error;
    }
    const hold = this.take(this.holds, path);
    if (hold) {
      hold.entered.resolve();
      await hold.release.promise;
      if (hold.outcome === "fail") {
        throw hold.failure;
      }
    }
    await writeJsonFileAtomic(path, record);
  };

  get writes(): number {
    return this.writeCount;
  }

  hold(hold: RecordWriteHold): void {
    this.holds.push(hold);
  }

  /** Fail the agent's next record write once; resolves `failed` when it does. */
  failNext(agentId: string, error: Error): { failed: () => boolean } {
    let failed = false;
    this.failures.push({
      agentId,
      error,
      failed: () => {
        failed = true;
      },
    });
    return { failed: () => failed };
  }

  reset(): void {
    for (const hold of this.holds.splice(0)) {
      hold.release.resolve();
    }
    this.failures.splice(0);
  }

  private take<T extends { agentId: string }>(entries: T[], path: string): T | undefined {
    const index = entries.findIndex((entry) => basename(path) === `${entry.agentId}.json`);
    return index === -1 ? undefined : entries.splice(index, 1)[0];
  }
}
const recordWrites = new RecordWriteGate();

function holdEscalationAtomicWrite(agentId: string, outcome: "fail" | "succeed") {
  const hold: RecordWriteHold = {
    agentId,
    outcome,
    entered: deferred<void>(),
    release: deferred<void>(),
    failure: new Error("Injected escalation atomic rename failure"),
  };
  const writesBefore = recordWrites.writes;
  recordWrites.hold(hold);
  onTestFinished(() => {
    hold.release.resolve();
    recordWrites.reset();
  });
  return { ...hold, writesSinceHold: () => recordWrites.writes - writesBefore };
}

test("escalation public competition retries the failed reason once", async () => {
  const { manager, request, notify } = await createEscalationFaultFixture({
    name: "competing-escalation",
  });
  const write = holdEscalationAtomicWrite(request.agentId, "fail");
  const first = manager.requestHumanAttention(request);
  void first.catch(() => undefined);
  try {
    await write.entered.promise;
    const second = manager.requestHumanAttention(request);
    expect(write.writesSinceHold()).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    write.release.resolve();
    await expect(first).rejects.toBe(write.failure);
    expect(await second).toEqual({ notified: true });
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: false });
    expectNotifiedOnce(notify, { agentId: request.agentId, message: request.reason });
  } finally {
    write.release.resolve();
    await Promise.allSettled([first]);
  }
});

test("escalation postcommit acknowledgement error keeps one durable announcement", async () => {
  const { manager, storage, request, notify } = await createEscalationFaultFixture({
    name: "committed-escalation-ack-error",
  });
  const write = holdEscalationSnapshot(storage, "fail-after-write");
  const first = manager.requestHumanAttention(request);
  void first.catch(() => undefined);
  try {
    await write.entered.promise;
    // Notification fires once the storage queue has committed the record; the outer
    // applySnapshot acknowledgement is not part of the guarantee.
    expectNotifiedOnce(notify, { agentId: request.agentId, message: request.reason });
    expect(await storage.get(request.agentId)).toEqual(
      expect.objectContaining({
        requiresAttention: true,
        attentionMessage: request.reason,
        attentionObjectives: expect.objectContaining({
          objectives: [
            expect.objectContaining({
              id: request.objectiveId,
              announcedReasons: [request.reason],
            }),
          ],
        }),
      }),
    );
    write.release.resolve();
    expect(await first).toEqual({ notified: true });
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: false });
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    write.release.resolve();
    await Promise.allSettled([first]);
  }
});

test("escalation held failure preserves newer manual review state", async () => {
  const { manager, storage, request, notify, worker, running } = await createEscalationFaultFixture(
    { name: "newer-manual-attention" },
  );
  const write = holdEscalationAtomicWrite(worker.id, "succeed");
  const first = manager.requestHumanAttention(request);
  void first.catch(() => undefined);
  try {
    await write.entered.promise;
    worker.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: worker.session.turnId,
    });
    await running;
    const nextTurnId = `${worker.session.turnId}-new-human`;
    vi.spyOn(worker.session, "startTurn").mockResolvedValueOnce({ turnId: nextTurnId });
    const next = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      options: { clientMessageId: "new-human-objective" },
      flush: false,
    });
    worker.session.pushEvent({ type: "turn_completed", provider: "codex", turnId: nextTurnId });
    await next.running;
    // Both public methods update live state before their queued writes await the held rename.
    const clearing = manager.clearAgentAttention(worker.id);
    const marking = manager.markAgentUnread(worker.id);
    void clearing.catch(() => undefined);
    void marking.catch(() => undefined);
    const before = manager.getAgent(worker.id);
    if (!before) throw new Error("Expected the new manually unread worker");
    const manualAttention = before.attention;
    expect(manualAttention.requiresAttention).toBe(true);
    write.release.resolve();
    await expect(first).rejects.toBeInstanceOf(AttentionObjectiveError);
    await Promise.all([clearing, marking]);
    await manager.flush();
    expect(manager.getAgent(worker.id)?.attention).toBe(manualAttention);
    expect(manager.getAgent(worker.id)?.attentionMessage).toBeUndefined();
    expect(
      manager
        .getTimeline(worker.id)
        .filter((item) => item.type === "tool_call" && item.name === "request_human_attention"),
    ).toEqual([]);
    expectNotifiedOnce(notify, { agentId: worker.id, message: undefined });
    expect((await storage.get(worker.id))?.attentionMessage).not.toBe(request.reason);
  } finally {
    write.release.resolve();
    await Promise.allSettled([first]);
  }
});

test("escalation held success rejects a retired objective with a reused ID", async () => {
  const { manager, request, notify, worker, running, requesterIdentity } =
    await createEscalationFaultFixture({ name: "same-id-retirement" });
  const write = holdEscalationAtomicWrite(worker.id, "succeed");
  const first = manager.requestHumanAttention(request);
  void first.catch(() => undefined);
  try {
    await write.entered.promise;
    worker.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: worker.session.turnId,
    });
    await running;
    const nextTurnId = `${worker.session.turnId}-same-id`;
    vi.spyOn(worker.session, "startTurn").mockResolvedValueOnce({ turnId: nextTurnId });
    const next = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      flush: false,
      options: {
        attention: [
          { kind: "agent", requestId: request.objectiveId, requester: requesterIdentity },
        ],
      },
    });
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
      request.objectiveId,
    ]);
    write.release.resolve();
    await expect(first).rejects.toBeInstanceOf(AttentionObjectiveError);
    expect(manager.getAgent(worker.id)?.activeTurnId).toBe(nextTurnId);
    expect(notify).not.toHaveBeenCalled();
    expect(
      manager
        .getTimeline(worker.id)
        .filter((item) => item.type === "tool_call" && item.name === "request_human_attention"),
    ).toEqual([]);
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: true });
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: false });
    worker.session.pushEvent({ type: "turn_completed", provider: "codex", turnId: nextTurnId });
    await next.running;
    expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });
  } finally {
    write.release.resolve();
    await Promise.allSettled([first]);
  }
});

test.each(["blocked", "resolved"] as const)(
  "background escalation retry for %s shares the failed public claim",
  async (state) => {
    const fixture = await createEscalationFaultFixture({
      name: `background-escalation-${state}`,
      requesterPeer: {
        agentId: randomUUID(),
        serverId: "remote",
      },
    });
    const { manager, request, worker, notify } = fixture;
    const availabilityEntered = deferred<void>();
    manager.setAttentionHost({
      serverId: "local",
      resolveRemoteRequester: async () => {
        availabilityEntered.resolve();
        return "missing";
      },
    });
    const orphanReason = REQUESTER_LOST_PERMISSION_MESSAGE;
    const write = holdEscalationAtomicWrite(request.agentId, "fail");
    const first = manager.requestHumanAttention({ ...request, reason: orphanReason });
    void first.catch(() => undefined);
    try {
      await write.entered.promise;
      worker.session.pushEvent({
        type: "permission_requested",
        provider: "codex",
        turnId: worker.session.turnId,
        request: { id: "background-permission", provider: "codex", kind: "tool", name: "Deploy" },
      });
      await availabilityEntered.promise;
      if (state === "resolved") {
        worker.session.pushEvent({
          type: "permission_resolved",
          provider: "codex",
          turnId: worker.session.turnId,
          requestId: "background-permission",
          resolution: { behavior: "deny" },
        });
        await vi.waitFor(() =>
          expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(0),
        );
      }
      write.release.resolve();
      await expect(first).rejects.toBe(write.failure);
      await manager.flush();
      expect(notify.mock.calls.map(([event]) => event.message)).toEqual(
        state === "blocked" ? [orphanReason] : [],
      );
    } finally {
      write.release.resolve();
      await Promise.allSettled([first]);
    }
  },
);

test("escalation close reload keeps the unannounced same objective retryable", async () => {
  const { manager, storage, request, notify, worker, running, requesterIdentity } =
    await createEscalationFaultFixture({ name: "unannounced-close-reload" });
  const original = manager.getAgent(worker.id);
  const write = holdEscalationAtomicWrite(worker.id, "succeed");
  const first = manager.requestHumanAttention(request);
  void first.catch(() => undefined);
  try {
    await write.entered.promise;
    expect((await storage.get(worker.id))?.attentionObjectives?.objectives).toContainEqual(
      expect.objectContaining({ id: request.objectiveId, announcedReasons: [] }),
    );
    expect(notify).not.toHaveBeenCalled();

    // Close retires the live owner before I/O completes; its snapshot queues behind that write.
    const closing = manager.closeAgent(worker.id);
    void closing.catch(() => undefined);
    await vi.waitFor(() => expect(manager.getAgent(worker.id)).toBeNull());
    write.release.resolve();
    await expect(first).rejects.toBeInstanceOf(AttentionObjectiveError);
    await closing;
    await Promise.allSettled([running]);
    expect(await storage.get(worker.id)).toEqual(
      expect.objectContaining({
        id: worker.id,
        lastStatus: "closed",
        requiresAttention: false,
        attentionObjectives: expect.objectContaining({
          activeObjectiveIds: [request.objectiveId],
          objectives: [
            expect.objectContaining({
              id: request.objectiveId,
              audience: { kind: "agent", requester: requesterIdentity },
              announcedReasons: [],
            }),
          ],
        }),
      }),
    );

    const restored = await ensureAgentLoaded(worker.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    expect(restored.attentionObjectives).not.toBe(original?.attentionObjectives);
    expect(restored.attentionObjectives?.describe()).toEqual(
      original?.attentionObjectives?.describe(),
    );
    expect(restored.attention.requiresAttention).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    if (!(restored.session instanceof ControlledInterruptSession)) {
      throw new Error("Expected a newly resumed controlled provider session");
    }
    const continuation = manager.captureAttentionContinuation(worker.id);
    if (!continuation) throw new Error("Expected the restored objective continuation");
    const resumed = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      options: { attention: [continuation] },
    });
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
      request.objectiveId,
    ]);
    expect(
      manager
        .getTimeline(worker.id)
        .filter((item) => item.type === "tool_call" && item.name === "request_human_attention"),
    ).toEqual([]);
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: true });
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: false });
    expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });
    expect((await storage.get(worker.id))?.attentionObjectives?.objectives).toContainEqual(
      expect.objectContaining({ id: request.objectiveId, announcedReasons: [request.reason] }),
    );
    restored.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: restored.session.turnId,
    });
    await resumed.running;
    await manager.flush();
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    write.release.resolve();
    await Promise.allSettled([first]);
  }
});

test("escalation committed acknowledgement delay preserves newer manual attention", async () => {
  const { manager, storage, request, notify, worker, running } = await createEscalationFaultFixture(
    {
      name: "manual-after-durable-commit",
    },
  );
  const write = holdEscalationSnapshot(storage, "succeed-after-write");
  const first = manager.requestHumanAttention(request);
  void first.catch(() => undefined);
  try {
    await write.entered.promise;
    expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });
    await manager.clearAgentAttention(worker.id);
    worker.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: worker.session.turnId,
    });
    await running;
    await manager.flush();
    const nextTurnId = `${worker.session.turnId}-after-commit`;
    vi.spyOn(worker.session, "startTurn").mockResolvedValueOnce({ turnId: nextTurnId });
    const next = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      options: { clientMessageId: "human-after-commit" },
    });
    worker.session.pushEvent({ type: "turn_completed", provider: "codex", turnId: nextTurnId });
    await next.running;
    await manager.flush();
    await manager.clearAgentAttention(worker.id);
    await manager.markAgentUnread(worker.id);
    const manual = manager.getAgent(worker.id)?.attention;
    if (!manual?.requiresAttention) throw new Error("Expected newer manual review attention");
    write.release.resolve();
    expect(await first).toEqual({ notified: true });
    await manager.flush();
    await storage.flush();
    expect(manager.getAgent(worker.id)?.attention).toBe(manual);
    expect(await storage.get(worker.id)).toEqual(
      expect.objectContaining({
        id: worker.id,
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: manual.attentionTimestamp.toISOString(),
      }),
    );
    expect((await storage.get(worker.id))?.attentionMessage).not.toBe(request.reason);
    expect(
      manager
        .getTimeline(worker.id)
        .filter((item) => item.type === "tool_call" && item.name === "request_human_attention"),
    ).toEqual([
      expect.objectContaining({
        status: "completed",
        detail: { type: "plain_text", text: request.reason },
      }),
    ]);
    expect(notify.mock.calls.map(([event]) => event.message)).toEqual([request.reason, undefined]);
  } finally {
    write.release.resolve();
    await Promise.allSettled([first]);
  }
});

test("escalation intervening permission snapshot retains the successful announcement", async () => {
  const { manager, storage, request, notify, worker, requesterIdentity } =
    await createEscalationFaultFixture({ name: "permission-during-escalation-write" });
  const write = holdEscalationSnapshot(storage, "succeed-after-write");
  const first = manager.requestHumanAttention(request);
  void first.catch(() => undefined);
  const permission = {
    id: "intervening-permission",
    provider: "codex",
    kind: "tool",
    name: "Deploy",
  } as const;
  try {
    await write.entered.promise;
    expect(await storage.get(requesterIdentity.agentId)).toEqual(
      expect.objectContaining({ id: requesterIdentity.agentId }),
    );
    expect((await storage.get(requesterIdentity.agentId))?.archivedAt).toBeUndefined();
    expect((await storage.get(worker.id))?.attentionMessage).toBe(request.reason);
    expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });

    worker.session.pushEvent({
      type: "permission_requested",
      provider: "codex",
      turnId: worker.session.turnId,
      request: permission,
    });
    await manager.flush();
    expect(manager.getAgent(worker.id)?.activeTurnId).toBe(worker.session.turnId);
    expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(permission);
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
      request.objectiveId,
    ]);
    // Prove the event's ordinary snapshot committed after the held successful candidate write.
    expect((await storage.get(worker.id))?.attentionObjectives?.requests?.checkpoints).toEqual([
      { turnId: worker.session.turnId, permissionId: permission.id },
    ]);
    expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });

    write.release.resolve();
    expect(await first).toEqual({ notified: true });
    await manager.flush();
    await storage.flush();
    expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });
    const live = manager.getAgent(worker.id);
    if (!live?.attention.requiresAttention) throw new Error("Expected successful human attention");
    expect(await storage.get(worker.id)).toEqual(
      expect.objectContaining({
        id: worker.id,
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: live.attention.attentionTimestamp.toISOString(),
        attentionMessage: request.reason,
        attentionObjectives: expect.objectContaining({
          activeObjectiveIds: [request.objectiveId],
          objectives: [
            expect.objectContaining({
              id: request.objectiveId,
              announcedReasons: [request.reason],
            }),
          ],
          requests: expect.objectContaining({
            checkpoints: [{ turnId: worker.session.turnId, permissionId: permission.id }],
          }),
        }),
      }),
    );
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: false });
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    write.release.resolve();
    await Promise.allSettled([first]);
  }
});

test("escalation durable commit precedes the next queued permission snapshot", async () => {
  const { manager, storage, request, notify, worker } = await createEscalationFaultFixture({
    name: "permission-queued-before-durable-commit",
  });
  const write = holdEscalationAtomicWrite(worker.id, "succeed");
  const first = manager.requestHumanAttention(request);
  void first.catch(() => undefined);
  const permission = {
    id: "queued-permission",
    provider: "codex",
    kind: "tool",
    name: "Deploy",
  } as const;
  try {
    await write.entered.promise;
    expect((await storage.get(worker.id))?.requiresAttention).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    worker.session.pushEvent({
      type: "permission_requested",
      provider: "codex",
      turnId: worker.session.turnId,
      request: permission,
    });
    // Ingestion may progress while this agent's existing storage queue is blocked on real I/O.
    await vi.waitFor(() =>
      expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(
        permission,
      ),
    );
    expect(manager.getAgent(worker.id)?.activeTurnId).toBe(worker.session.turnId);
    expect(notify).not.toHaveBeenCalled();
    write.release.resolve();
    expect(await first).toEqual({ notified: true });
    await manager.flush();
    await storage.flush();
    expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });
    expect(await storage.get(worker.id)).toEqual(
      expect.objectContaining({
        id: worker.id,
        requiresAttention: true,
        attentionReason: "finished",
        attentionMessage: request.reason,
        attentionObjectives: expect.objectContaining({
          activeObjectiveIds: [request.objectiveId],
          objectives: [
            expect.objectContaining({
              id: request.objectiveId,
              announcedReasons: [request.reason],
            }),
          ],
          requests: expect.objectContaining({
            checkpoints: [{ turnId: worker.session.turnId, permissionId: permission.id }],
          }),
        }),
      }),
    );
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: false });
    expect(notify).toHaveBeenCalledTimes(1);
  } finally {
    write.release.resolve();
    await Promise.allSettled([first]);
  }
});

test("escalation retired write repairs current attention after acknowledgement failure", async () => {
  const { manager, storage, request, notify, worker, running } = await createEscalationFaultFixture(
    {
      name: "retired-written-ack-failure",
      nativeStart: true,
    },
  );
  const io = holdEscalationAtomicWrite(worker.id, "succeed");
  const acknowledgement = holdEscalationSnapshot(storage, "fail-after-write");
  const first = manager.requestHumanAttention(request);
  void first.catch(() => undefined);
  try {
    await io.entered.promise;
    worker.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: worker.session.turnId,
    });
    await running;
    const nextTurnId = `${worker.session.turnId}-retire-before-ack`;
    vi.spyOn(worker.session, "startTurn").mockResolvedValueOnce({ turnId: nextTurnId });
    const next = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      options: { clientMessageId: "human-before-written-ack" },
      flush: false,
    });
    worker.session.pushEvent({ type: "turn_completed", provider: "codex", turnId: nextTurnId });
    await next.running;
    const clearing = manager.clearAgentAttention(worker.id);
    const marking = manager.markAgentUnread(worker.id);
    void clearing.catch(() => undefined);
    void marking.catch(() => undefined);
    const manual = manager.getAgent(worker.id)?.attention;
    if (!manual?.requiresAttention) throw new Error("Expected the newer manual attention");

    // One real later write fails, so queued ordinary saves cannot accidentally mask missing repair.
    const ordinaryFailure = new Error("Injected ordinary snapshot atomic rename failure");
    const ordinaryWrite = recordWrites.failNext(worker.id, ordinaryFailure);
    io.release.resolve();
    await acknowledgement.entered.promise;
    expect(await Promise.allSettled([clearing, marking])).toEqual([
      { status: "rejected", reason: ordinaryFailure },
      { status: "rejected", reason: ordinaryFailure },
    ]);
    await manager.flush();
    expect(ordinaryWrite.failed()).toBe(true);
    expect((await storage.get(worker.id))?.attentionMessage).toBe(request.reason);
    expect(manager.getAgent(worker.id)?.attention).toBe(manual);

    acknowledgement.release.resolve();
    await expect(first).rejects.toBe(acknowledgement.failure);
    await manager.flush();
    expect(manager.getAgent(worker.id)?.attention).toBe(manual);
    expect(await storage.get(worker.id)).toEqual(
      expect.objectContaining({
        id: worker.id,
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: manual.attentionTimestamp.toISOString(),
        attentionMessage: undefined,
        attentionObjectives: expect.objectContaining({ activeObjectiveIds: [], objectives: [] }),
      }),
    );
    expectNotifiedOnce(notify, { agentId: worker.id, message: undefined });
    expect(
      manager
        .getTimeline(worker.id)
        .filter((item) => item.type === "tool_call" && item.name === "request_human_attention"),
    ).toEqual([]);
  } finally {
    io.release.resolve();
    acknowledgement.release.resolve();
    await Promise.allSettled([first]);
  }
});

test.each(["timeline", "state", "notification"] as const)(
  "escalation throwing %s observer preserves commit and later snapshots",
  async (throwingPhase) => {
    const { manager, storage, request, notify, worker } = await createEscalationFaultFixture({
      name: `observer-throws-${throwingPhase}`,
    });
    const attempted: string[] = [];
    const failure = new Error(`Injected ${throwingPhase} observer failure`);
    const unsubscribe = manager.subscribe(
      (event) => {
        if (
          event.type === "agent_stream" &&
          event.event.type === "timeline" &&
          event.event.item.type === "tool_call" &&
          event.event.item.name === "request_human_attention"
        ) {
          attempted.push("timeline");
          if (throwingPhase === "timeline") throw failure;
        }
        if (event.type === "agent_state" && event.agent.attentionMessage === request.reason) {
          attempted.push("state");
          if (throwingPhase === "state") throw failure;
        }
      },
      { agentId: worker.id, replayState: false },
    );
    manager.setAgentAttentionCallback((event) => {
      attempted.push("notification");
      notify(event);
      if (throwingPhase === "notification") throw failure;
    });
    try {
      expect(await manager.requestHumanAttention(request)).toEqual({ notified: true });
      expect(attempted).toEqual(["timeline", "state", "notification"]);
      expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });
      expect(
        manager
          .getTimeline(worker.id)
          .filter((item) => item.type === "tool_call" && item.name === "request_human_attention"),
      ).toEqual([
        expect.objectContaining({
          status: "completed",
          detail: { type: "plain_text", text: request.reason },
        }),
      ]);
      expect(await manager.requestHumanAttention(request)).toEqual({ notified: false });
      unsubscribe();
      manager.setAgentAttentionCallback(notify);
      const permissionId = `permission-after-${throwingPhase}-failure`;
      worker.session.pushEvent({
        type: "permission_requested",
        provider: "codex",
        turnId: worker.session.turnId,
        request: { id: permissionId, provider: "codex", kind: "tool", name: "Deploy" },
      });
      await vi.waitFor(() =>
        expect(manager.getAgent(worker.id)?.pendingPermissions.has(permissionId)).toBe(true),
      );
      await manager.flush();
      expect(await storage.get(worker.id)).toEqual(
        expect.objectContaining({
          requiresAttention: true,
          attentionMessage: request.reason,
          attentionObjectives: expect.objectContaining({
            objectives: [
              expect.objectContaining({
                id: request.objectiveId,
                announcedReasons: [request.reason],
              }),
            ],
            requests: expect.objectContaining({
              checkpoints: [{ turnId: worker.session.turnId, permissionId }],
            }),
          }),
        }),
      );
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      manager.setAgentAttentionCallback(notify);
    }
  },
);

/** Publish one actual provider resolution without changing manager state directly. */
function resolvePermissionDisposition(
  handoff: Awaited<ReturnType<typeof createPermissionHandoffFixture>>,
  requestId: string,
): void {
  handoff.worker.session.pushEvent({
    type: "permission_resolved",
    provider: "codex",
    turnId: handoff.planTurnId,
    requestId,
    resolution: { behavior: "allow" },
  });
}

/** Queue checkpoints without a terminal so each case controls its real terminal ordering. */
async function queuePermissionDisposition(
  handoff: Awaited<ReturnType<typeof createPermissionHandoffFixture>>,
  requests: AgentPermissionRequest[],
  text = "Proposed plan, not implementation output",
): Promise<void> {
  handoff.worker.session.pushEvent({
    type: "timeline",
    provider: "codex",
    turnId: handoff.planTurnId,
    item: { type: "assistant_message", text },
  });
  for (const request of requests) {
    handoff.worker.session.pushEvent({
      type: "permission_requested",
      provider: "codex",
      turnId: handoff.planTurnId,
      request,
    });
  }
  await handoff.manager.flush();
}

/** Check final human publication and immutable agent-owned outcomes through public storage. */
async function expectPermissionDispositionFinished(input: {
  handoff: Awaited<ReturnType<typeof createPermissionHandoffFixture>>;
  audience: "human" | "agent";
  turnId: string;
  text: string;
  checkpointIds?: string[];
}): Promise<void> {
  const { handoff, audience, turnId, text } = input;
  const { manager, storage, worker, notify } = handoff;
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([]);
  expect(await manager.getLastAssistantMessage(worker.id)).toBe(text);
  const snapshot = manager.getAgent(worker.id);
  if (!snapshot) throw new Error("Expected the completed permission worker");
  expect(toAgentPayload(snapshot).humanAttentionRequired).toBe(audience === "human");
  const finishedNotifications = notify.mock.calls
    .map(([event]) => event)
    .filter((event) => event.reason === "finished");
  expect(finishedNotifications).toEqual(
    audience === "human"
      ? [{ agentId: worker.id, provider: "codex", reason: "finished", message: undefined }]
      : [],
  );
  if (audience === "human") return;
  expect(notify).not.toHaveBeenCalled();
  const checkpoints = (input.checkpointIds ?? ["plan-approval"]).map((id) =>
    expect.objectContaining({
      kind: "permission",
      acceptedTurnId: handoff.planTurnId,
      permission: expect.objectContaining({ id }),
    }),
  );
  expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
    expect.objectContaining({
      link: handoff.link,
      requester: handoff.requesterPeer,
      turnId,
      active: false,
      outcomes: [
        ...checkpoints,
        expect.objectContaining({
          kind: "finished",
          acceptedTurnId: turnId,
          requestId: handoff.link.requestId,
          lastMessage: text,
          error: null,
        }),
      ],
    }),
  ]);
}

/**
 * Publish the follow-up implementation turn the way Codex does: turn start, the echo of the
 * submitted prompt, the assistant result, then completion.
 */
function publishImplementationTurn(input: {
  session: { pushEvent(event: AgentStreamEvent): void };
  turnId: string;
  prompt: string;
  echoMessageId: string;
}) {
  const { session, turnId } = input;
  session.pushEvent({ type: "turn_started", provider: "codex", turnId });
  session.pushEvent({
    type: "timeline",
    provider: "codex",
    turnId,
    item: { type: "user_message", messageId: input.echoMessageId, text: input.prompt },
  });
  session.pushEvent({
    type: "timeline",
    provider: "codex",
    turnId,
    item: { type: "assistant_message", text: "Exact implementation result" },
  });
  session.pushEvent({ type: "turn_completed", provider: "codex", turnId });
}

/** Finish only the helper's real next accepted turn, including Codex's prompt echo boundary. */
async function finishPermissionDispositionImplementation(
  handoff: Awaited<ReturnType<typeof createPermissionHandoffFixture>>,
  checkpointIds = ["plan-approval"],
): Promise<void> {
  const { manager, worker, objectiveId } = handoff;
  await manager.waitForAgentRunStart(worker.id);
  expect(handoff.providerStart).toHaveBeenCalledTimes(2);
  expect(handoff.providerStart).toHaveBeenNthCalledWith(
    2,
    handoff.followUpPrompt,
    expect.objectContaining({
      attention: [expect.objectContaining({ kind: "continuation", objectiveIds: [objectiveId] })],
    }),
  );
  expect(manager.getAgent(worker.id)?.activeTurnId).toBe(handoff.nextTurnId);
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([objectiveId]);
  publishImplementationTurn({
    session: worker.session,
    turnId: handoff.nextTurnId,
    prompt: handoff.followUpPrompt,
    echoMessageId: "disposition-implementation-echo",
  });
  await manager.flush();
  await expectPermissionDispositionFinished({
    handoff,
    audience: handoff.audience,
    turnId: handoff.nextTurnId,
    text: "Exact implementation result",
    checkpointIds,
  });
}

test.each(["human", "agent"] as const)(
  "permission terminal before classification for %s preserves follow-up",
  async (audience) => {
    const handoff = await createPermissionHandoffFixture(audience);
    const providerEntered = deferred<void>();
    const releaseProvider = deferred<void>();
    handoff.providerResponse.mockImplementationOnce(async () => {
      resolvePermissionDisposition(handoff, "plan-approval");
      providerEntered.resolve();
      await releaseProvider.promise;
      return { followUpPrompt: handoff.followUpPrompt };
    });
    onTestFinished(() => releaseProvider.resolve());
    try {
      handoff.queuePlanBoundary();
      await providerEntered.promise;
      await handoff.planning;
      await handoff.manager.flush();
      expect(handoff.manager.getAgent(handoff.worker.id)?.pendingPermissions.size).toBe(0);
      expect(handoff.manager.getAttentionObjectives(handoff.worker.id).activeObjectiveIds).toEqual([
        handoff.objectiveId,
      ]);
      expect(handoff.notify.mock.calls.map(([event]) => event.reason)).toEqual(
        audience === "human" ? ["permission"] : [],
      );
      releaseProvider.resolve();
      await handoff.refreshEntered.promise;
      expect(handoff.providerStart).toHaveBeenCalledTimes(1);
      expect(handoff.manager.getAttentionObjectives(handoff.worker.id).activeObjectiveIds).toEqual([
        handoff.objectiveId,
      ]);
    } finally {
      releaseProvider.resolve();
      handoff.releaseRefresh.resolve();
      await Promise.allSettled([handoff.approval.promise]);
    }
    await handoff.approval.promise;
    await finishPermissionDispositionImplementation(handoff);
  },
);

test.each(["human", "agent"] as const)(
  "permission no-follow-up classification for %s finishes during refresh",
  async (audience) => {
    const handoff = await createPermissionHandoffFixture(audience);
    const { manager, worker, notify } = handoff;
    handoff.providerResponse.mockImplementationOnce(async () => {
      resolvePermissionDisposition(handoff, "final-permission");
    });
    try {
      await queuePermissionDisposition(
        handoff,
        [{ id: "final-permission", provider: "codex", kind: "tool", name: "Run" }],
        "Exact final response during refresh",
      );
      await handoff.refreshEntered.promise;
      await manager.clearAgentAttention(worker.id);
      notify.mockClear();
      expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(0);
      expect(handoff.providerStart).toHaveBeenCalledTimes(1);
      worker.session.pushEvent({
        type: "turn_completed",
        provider: "codex",
        turnId: handoff.planTurnId,
      });
      await handoff.planning;
      await manager.flush();
      // The provider classified no-follow-up before this terminal; refresh is still held.
      await expectPermissionDispositionFinished({
        handoff,
        audience,
        turnId: handoff.planTurnId,
        text: "Exact final response during refresh",
        checkpointIds: ["final-permission"],
      });
    } finally {
      handoff.releaseRefresh.resolve();
      await Promise.allSettled([handoff.approval.promise]);
    }
    await handoff.approval.promise;
    await manager.flush();
    expect(handoff.providerStart).toHaveBeenCalledTimes(1);
    await expectPermissionDispositionFinished({
      handoff,
      audience,
      turnId: handoff.planTurnId,
      text: "Exact final response during refresh",
      checkpointIds: ["final-permission"],
    });
  },
);

test("permission late terminal after response settlement retains helper continuation", async () => {
  const handoff = await createPermissionHandoffFixture("agent");
  const { manager, worker, storage } = handoff;
  handoff.stopAutomaticApproval();
  handoff.releaseRefresh.resolve();
  const responseSettled = deferred<void>();
  const releaseHelper = deferred<void>();
  const originalResponse = manager.respondToPermission.bind(manager);
  const response = vi.spyOn(manager, "respondToPermission").mockImplementation(async (...args) => {
    const result = await originalResponse(...args);
    responseSettled.resolve();
    await releaseHelper.promise;
    return result;
  });
  onTestFinished(() => {
    releaseHelper.resolve();
    response.mockRestore();
  });
  await queuePermissionDisposition(handoff, [
    { id: "plan-approval", provider: "codex", kind: "plan", name: "Implement plan" },
  ]);
  const approving = respondToAgentPermission({
    agentManager: manager,
    agentId: worker.id,
    requestId: "plan-approval",
    response: { behavior: "allow" },
    logger,
  });
  void approving.catch(() => undefined);
  try {
    await responseSettled.promise;
    expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(0);
    worker.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: handoff.planTurnId,
    });
    await handoff.planning;
    await manager.flush();
    expect(handoff.providerStart).toHaveBeenCalledTimes(1);
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
      handoff.objectiveId,
    ]);
    expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
      expect.objectContaining({
        link: handoff.link,
        active: true,
        outcomes: [
          expect.objectContaining({ kind: "permission", acceptedTurnId: handoff.planTurnId }),
        ],
      }),
    ]);
    expect(handoff.notify).not.toHaveBeenCalled();
  } finally {
    releaseHelper.resolve();
    await Promise.allSettled([approving]);
  }
  await approving;
  await finishPermissionDispositionImplementation(handoff);
});

test("permission mixed responses retain the unresolved follow-up obligation", async () => {
  const handoff = await createPermissionHandoffFixture("agent");
  const { manager, worker } = handoff;
  handoff.stopAutomaticApproval();
  const firstPermission = {
    id: "first-response",
    provider: "codex",
    kind: "tool",
    name: "Run",
  } as const;
  const secondPermission = {
    id: "second-response",
    provider: "codex",
    kind: "plan",
    name: "Implement",
  } as const;
  const providerEntered = deferred<void>();
  const releaseProvider = deferred<void>();
  handoff.providerResponse
    .mockImplementationOnce(async () => {
      resolvePermissionDisposition(handoff, firstPermission.id);
    })
    .mockImplementationOnce(async () => {
      resolvePermissionDisposition(handoff, secondPermission.id);
      providerEntered.resolve();
      await releaseProvider.promise;
      return { followUpPrompt: handoff.followUpPrompt };
    });
  onTestFinished(() => {
    releaseProvider.resolve();
  });
  await queuePermissionDisposition(handoff, [firstPermission, secondPermission]);
  const first = respondToAgentPermission({
    agentManager: manager,
    agentId: worker.id,
    requestId: firstPermission.id,
    response: { behavior: "allow" },
    logger,
  });
  void first.catch(() => undefined);
  await handoff.refreshEntered.promise;
  expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(1);
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(secondPermission.id)).toEqual(
    secondPermission,
  );
  const second = respondToAgentPermission({
    agentManager: manager,
    agentId: worker.id,
    requestId: secondPermission.id,
    response: { behavior: "allow" },
    logger,
  });
  void second.catch(() => undefined);
  try {
    await providerEntered.promise;
    // Both provider submissions began before the first helper settles; the second stays unknown.
    handoff.releaseRefresh.resolve();
    await first;
    worker.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: handoff.planTurnId,
    });
    await handoff.planning;
    await manager.flush();
    expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(0);
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
      handoff.objectiveId,
    ]);
    expect(handoff.providerStart).toHaveBeenCalledTimes(1);
    expect(handoff.notify).not.toHaveBeenCalled();
  } finally {
    handoff.releaseRefresh.resolve();
    releaseProvider.resolve();
    await Promise.allSettled([first, second]);
  }
  await second;
  await finishPermissionDispositionImplementation(handoff, [
    firstPermission.id,
    secondPermission.id,
  ]);
});

test("permission rejected response remains retryable without finishing the plan", async () => {
  const handoff = await createPermissionHandoffFixture("agent");
  const { manager, worker } = handoff;
  handoff.stopAutomaticApproval();
  handoff.releaseRefresh.resolve();
  const failure = new Error("Provider did not accept permission response");
  handoff.providerResponse.mockRejectedValueOnce(failure);
  await queuePermissionDisposition(handoff, [
    { id: "plan-approval", provider: "codex", kind: "plan", name: "Implement plan" },
  ]);
  const respond = () =>
    respondToAgentPermission({
      agentManager: manager,
      agentId: worker.id,
      requestId: "plan-approval",
      response: { behavior: "allow" },
      logger,
    });
  await expect(respond()).rejects.toBe(failure);
  expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(1);
  worker.session.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: handoff.planTurnId,
  });
  await handoff.planning;
  await manager.flush();
  expect(handoff.providerStart).toHaveBeenCalledTimes(1);
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
    handoff.objectiveId,
  ]);
  expect(handoff.notify).not.toHaveBeenCalled();
  // The first submission left the real pending permission intact, so the public retry is valid.
  await respond();
  expect(handoff.providerResponse).toHaveBeenCalledTimes(2);
  expect(handoff.providerResponse).toHaveBeenNthCalledWith(1, "plan-approval", {
    behavior: "allow",
  });
  expect(handoff.providerResponse).toHaveBeenNthCalledWith(2, "plan-approval", {
    behavior: "allow",
  });
  await finishPermissionDispositionImplementation(handoff);
});

test("permission retired response cannot mute a newer human final", async () => {
  const handoff = await createPermissionHandoffFixture("agent");
  const { manager, worker, notify, storage } = handoff;
  try {
    handoff.queuePlanBoundary();
    await handoff.refreshEntered.promise;
    await handoff.planning;
    await manager.flush();
    const next = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      options: { clientMessageId: "human-final-before-old-response" },
    });
    expect(handoff.providerStart).toHaveBeenCalledTimes(2);
    expect(manager.getAgent(worker.id)?.activeTurnId).toBe(handoff.nextTurnId);
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
      "human-final-before-old-response",
    ]);
    expect(notify).not.toHaveBeenCalled();
    worker.session.pushEvent({
      type: "turn_started",
      provider: "codex",
      turnId: handoff.nextTurnId,
    });
    worker.session.pushEvent({
      type: "timeline",
      provider: "codex",
      turnId: handoff.nextTurnId,
      item: {
        type: "user_message",
        messageId: "new-human-prompt-echo",
        text: "Exercise the accepted objective",
      },
    });
    worker.session.pushEvent({
      type: "timeline",
      provider: "codex",
      turnId: handoff.nextTurnId,
      item: { type: "assistant_message", text: "Exact newer human final before old refresh" },
    });
    worker.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: handoff.nextTurnId,
    });
    await next.running;
    await manager.flush();
    // The old provider response is still inside its original held refresh, not its helper finally.
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([]);
    expect(await manager.getLastAssistantMessage(worker.id)).toBe(
      "Exact newer human final before old refresh",
    );
    expectNotifiedOnce(notify, { agentId: worker.id, message: undefined });
    expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
      expect.objectContaining({
        link: handoff.link,
        turnId: handoff.planTurnId,
        active: false,
        outcomes: [
          expect.objectContaining({ kind: "permission", acceptedTurnId: handoff.planTurnId }),
          expect.objectContaining({
            kind: "canceled",
            acceptedTurnId: handoff.planTurnId,
            error: "Replaced by another accepted request",
            lastMessage: "Proposed plan, not implementation output",
          }),
        ],
      }),
    ]);
  } finally {
    handoff.releaseRefresh.resolve();
    await Promise.allSettled([handoff.approval.promise]);
  }
  await expect(handoff.approval.promise).rejects.toBeInstanceOf(AttentionObjectiveError);
  await manager.flush();
  expect(handoff.providerStart).toHaveBeenCalledTimes(2);
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([]);
  expect(await manager.getLastAssistantMessage(worker.id)).toBe(
    "Exact newer human final before old refresh",
  );
  expect(notify).toHaveBeenCalledTimes(1);
  expect(
    (await storage.get(worker.id))?.attentionObjectives?.requests?.records?.[0]?.outcomes.map(
      (outcome) => ({
        kind: outcome.kind,
        turnId: outcome.acceptedTurnId,
        lastMessage: outcome.lastMessage,
      }),
    ),
  ).toEqual([
    {
      kind: "permission",
      turnId: handoff.planTurnId,
      lastMessage: "Proposed plan, not implementation output",
    },
    {
      kind: "canceled",
      turnId: handoff.planTurnId,
      lastMessage: "Proposed plan, not implementation output",
    },
  ]);
});

/** Real storage/manager fixture using the suite's provider that supports accepted live steers. */
async function createSameTurnQuestionFixture() {
  const fixture = createRecordingClientFixture({
    directoryPrefix: "agent-attention-same-turn-question-",
    hooks: () => ({ create: (config) => new SteeringTestSession(config) }),
  });
  const { manager, storage } = fixture;
  const requester = await fixture.createAgent();
  const { session, ...worker } = await fixture.createAgent();
  await startAttentionRegressionTurn({
    manager,
    agentId: requester.id,
    options: { clientMessageId: "question-source" },
  });
  await manager.reportObjectiveStatus({
    agentId: requester.id,
    objectiveId: "question-source",
    disposition: "waiting",
  });
  const firstAttention = await manager.prepareAttentionMessage({
    agentId: requester.id,
    recipient: { agentId: worker.id },
  });
  const secondAttention = await manager.prepareAttentionMessage({
    agentId: requester.id,
    recipient: { agentId: worker.id },
  });
  const firstLink = firstAttention?.requesterObjective;
  const secondLink = secondAttention?.requesterObjective;
  if (!firstLink || !secondLink)
    throw new Error("Expected two exact requester-issued agent messages");
  const first = { ...firstAttention, requesterObjective: firstLink };
  const second = { ...secondAttention, requesterObjective: secondLink };
  const requesterPeer = manager.attentionRequester(requester.id);
  const admission = (attention: typeof first) => ({
    kind: "agent" as const,
    requestId: attention.requesterObjective.requestId,
    requester: requesterPeer,
    attention,
  });
  const notify = observeAttentionNotifications(manager);
  const { running } = await startAttentionRegressionTurn({
    manager,
    agentId: worker.id,
    options: { clientMessageId: first.requesterObjective.requestId, attention: [admission(first)] },
  });
  return {
    manager,
    storage,
    worker,
    session,
    first,
    second,
    requesterPeer,
    admission,
    running,
    notify,
  };
}

test("permission same-turn steer preserves an earlier async question follow-up", async () => {
  const fixture = await createSameTurnQuestionFixture();
  const {
    manager,
    storage,
    worker,
    session,
    first,
    second,
    requesterPeer,
    admission,
    running,
    notify,
  } = fixture;
  const questions = new CodexAsyncQuestions(undefined);
  const item = {
    type: "agentMessage",
    id: "question-before-steer",
    delivery: "async",
    questions: [{ title: "Which deployment environment?", options: ["Staging", "Production"] }],
  };
  const question = questions.receive(item);
  const timeline = codexAsyncQuestionToTimeline(item);
  if (!question || !timeline)
    throw new Error("Expected the actual Codex asynchronous question contract");
  const oldTurnId = "active-turn-1";
  session.pushEvent({
    type: "timeline",
    provider: "codex",
    turnId: oldTurnId,
    item: { type: "assistant_message", text: "Question belonging to request A" },
  });
  session.pushEvent({ type: "timeline", provider: "codex", turnId: oldTurnId, item: timeline });
  session.pushEvent({
    type: "permission_requested",
    provider: "codex",
    turnId: oldTurnId,
    request: question,
  });
  await manager.flush();
  expect(questions.hasPending(question.id)).toBe(true);
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(question.id)).toEqual(question);
  const steer = await manager.steerAgentRun(worker.id, "Continue with request B after I answer", {
    clientMessageId: second.requesterObjective.requestId,
    attention: [admission(second)],
  });
  expect(steer).toEqual({ status: "accepted" });
  await manager.flush();
  expect(session.steerCount).toBe(1);
  expect(session.startCount).toBe(1);
  expect(questions.hasPending(question.id)).toBe(true);
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(question.id)).toEqual(question);
  expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
    expect.objectContaining({
      link: first.requesterObjective,
      active: true,
      outcomes: [
        expect.objectContaining({
          kind: "permission",
          acceptedTurnId: oldTurnId,
          permission: question,
          lastMessage: "Question belonging to request A",
        }),
      ],
    }),
    expect.objectContaining({ link: second.requesterObjective, active: true, outcomes: [] }),
  ]);
  session.pushEvent({
    type: "timeline",
    provider: "codex",
    turnId: oldTurnId,
    item: { type: "assistant_message", text: "Partial response after the accepted steer" },
  });
  session.pushEvent({ type: "turn_completed", provider: "codex", turnId: oldTurnId });
  await running;
  await manager.flush();
  expect(manager.getAgent(worker.id)?.lifecycle).toBe("idle");
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(question.id)).toEqual(question);
  expect(questions.hasPending(question.id)).toBe(true);
  const activeIds = [first.requesterObjective.requestId, second.requesterObjective.requestId];
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual(activeIds);
  expect(notify).not.toHaveBeenCalled();

  const response = {
    behavior: "allow",
    updatedInput: { answers: { "Question 1": "Staging" } },
  } as const;
  const expectedFollowUpPrompt =
    "Answers to your questions:\n\nWhich deployment environment?\nStaging";
  const providerResponse = vi
    .spyOn(session, "respondToPermission")
    .mockImplementationOnce(async () => {
      // Codex uses a follow-up prompt when this answer arrives after its original provider turn ended.
      const prepared = questions.prepareResponse(question.id, response);
      const followUpPrompt = prepared.prompt;
      if (!followUpPrompt) throw new Error("Expected the real answer prompt");
      expect(followUpPrompt).toBe(expectedFollowUpPrompt);
      session.pushEvent({ type: "timeline", provider: "codex", item: prepared.complete() });
      session.pushEvent({
        type: "permission_resolved",
        provider: "codex",
        requestId: question.id,
        resolution: response,
      });
      return { followUpPrompt };
    });
  const refreshEntered = deferred<void>();
  const releaseRefresh = deferred<void>();
  const refresh = vi.spyOn(session, "getAvailableModes").mockImplementationOnce(async () => {
    refreshEntered.resolve();
    await releaseRefresh.promise;
    return [];
  });
  const implementationStarted = deferred<void>();
  const unsubscribeStart = session.subscribe((event) => {
    if (event.type === "turn_started" && event.turnId === "active-turn-2") {
      implementationStarted.resolve();
    }
  });
  onTestFinished(unsubscribeStart);
  onTestFinished(() => {
    releaseRefresh.resolve();
    refresh.mockRestore();
    providerResponse.mockRestore();
  });
  const answering = respondToAgentPermission({
    agentManager: manager,
    agentId: worker.id,
    requestId: question.id,
    response,
    logger,
  });
  void answering.catch(() => undefined);
  try {
    await refreshEntered.promise;
    await manager.flush();
    expect(providerResponse).toHaveBeenCalledExactlyOnceWith(question.id, response);
    expect(questions.hasPending(question.id)).toBe(false);
    expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(0);
    expect(session.startCount).toBe(1);
    expect(manager.getAttentionObjectives(worker.id)).toEqual({
      activeObjectiveIds: activeIds,
      objectives: activeIds.map((id) => ({
        id,
        audience: { kind: "agent", requester: requesterPeer },
        disposition: "normal",
      })),
    });
    expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
      expect.objectContaining({
        link: first.requesterObjective,
        active: true,
        outcomes: [
          expect.objectContaining({
            kind: "permission",
            acceptedTurnId: oldTurnId,
            permission: question,
          }),
        ],
      }),
      expect.objectContaining({ link: second.requesterObjective, active: true, outcomes: [] }),
    ]);
    expect(notify).not.toHaveBeenCalled();
  } finally {
    releaseRefresh.resolve();
    await Promise.allSettled([answering]);
  }
  await answering;
  await manager.waitForAgentRunStart(worker.id);
  // Acceptance publishes a manager start before this provider's delayed native start.
  await implementationStarted.promise;
  await manager.flush();
  expect(session.startCount).toBe(2);
  expect(session.steerCount).toBe(1);
  expect(session.interruptCount).toBe(0);
  expect(session.startPrompts.at(-1)).toBe(expectedFollowUpPrompt);
  expect(manager.getAgent(worker.id)?.activeTurnId).toBe("active-turn-2");
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual(activeIds);
  session.pushEvent({
    type: "timeline",
    provider: "codex",
    turnId: "active-turn-2",
    item: {
      type: "user_message",
      messageId: "async-answer-prompt-echo",
      text: expectedFollowUpPrompt,
    },
  });
  session.pushEvent({
    type: "timeline",
    provider: "codex",
    turnId: "active-turn-2",
    item: { type: "assistant_message", text: "Exact implementation for A and B" },
  });
  session.pushEvent({ type: "turn_completed", provider: "codex", turnId: "active-turn-2" });
  await manager.flush();
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([]);
  expect(await manager.getLastAssistantMessage(worker.id)).toBe("Exact implementation for A and B");
  const finalOutcome = (requestId: string) =>
    expect.objectContaining({
      kind: "finished",
      requestId,
      acceptedTurnId: "active-turn-2",
      lastMessage: "Exact implementation for A and B",
      error: null,
    });
  expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
    expect.objectContaining({
      link: first.requesterObjective,
      requester: requesterPeer,
      turnId: "active-turn-2",
      active: false,
      outcomes: [
        expect.objectContaining({
          kind: "permission",
          acceptedTurnId: oldTurnId,
          permission: question,
          lastMessage: "Question belonging to request A",
        }),
        finalOutcome(first.requesterObjective.requestId),
      ],
    }),
    expect.objectContaining({
      link: second.requesterObjective,
      requester: requesterPeer,
      turnId: "active-turn-2",
      active: false,
      outcomes: [finalOutcome(second.requesterObjective.requestId)],
    }),
  ]);
  const snapshot = manager.getAgent(worker.id);
  if (!snapshot) throw new Error("Expected the implemented worker");
  expect(toAgentPayload(snapshot).humanAttentionRequired).toBe(false);
  expect(notify).not.toHaveBeenCalled();
});

/** Keep provider pending state real across events and Codex async-question handle restoration. */
class RequesterLossSession extends SteeringTestSession {
  readonly questions: CodexAsyncQuestions;
  private readonly toolPermissions = new Map<string, AgentPermissionRequest>();

  constructor(config: AgentSessionConfig, savedQuestions?: unknown) {
    super(config);
    this.questions = new CodexAsyncQuestions(savedQuestions);
  }

  override pushEvent(event: AgentStreamEvent): void {
    if (event.type === "permission_requested" && !this.questions.hasPending(event.request.id)) {
      this.toolPermissions.set(event.request.id, event.request);
    }
    if (event.type === "permission_resolved") this.toolPermissions.delete(event.requestId);
    if (event.type === "turn_canceled" || event.type === "turn_failed")
      this.toolPermissions.clear();
    super.pushEvent(event);
  }

  override getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.toolPermissions.values(), ...this.questions.pending()];
  }

  override describePersistence() {
    return {
      ...super.describePersistence(),
      metadata: { asyncQuestions: this.questions.serialize() },
    };
  }

  override async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    let followUpPrompt: string | undefined;
    if (this.questions.hasPending(requestId)) {
      const prepared = this.questions.prepareResponse(requestId, response);
      followUpPrompt = prepared.prompt;
      this.pushEvent({ type: "timeline", provider: "codex", item: prepared.complete() });
    }
    this.pushEvent({
      type: "permission_resolved",
      provider: "codex",
      requestId,
      resolution: response,
    });
    if (followUpPrompt) return { followUpPrompt };
  }

  /** Receive the real persisted question payload, rather than fabricating pending manager state. */
  requestQuestion(itemId: string): AgentPermissionRequest {
    const item = {
      type: "agentMessage",
      id: itemId,
      delivery: "async",
      questions: [{ title: "Which account?", options: ["Staging", "Production"] }],
    };
    const request = this.questions.receive(item);
    const timeline = codexAsyncQuestionToTimeline(item);
    if (!request || !timeline) throw new Error("Expected a new actual Codex async question");
    const turnId = `active-turn-${this.startCount}`;
    this.pushEvent({ type: "timeline", provider: "codex", turnId, item: timeline });
    this.pushEvent({ type: "permission_requested", provider: "codex", turnId, request });
    return request;
  }
}

/** Reuse real lifecycle/storage contracts and a provider whose resume restores current questions. */
function createRequesterLossFixture(name: string) {
  const timeline = new InMemoryAgentTimelineStore();
  const fixture = createRecordingClientFixture({
    directoryPrefix: `agent-requester-loss-${name}-`,
    timelineStore: timeline,
    hooks: (workdir) => ({
      create: (config) => new RequesterLossSession(config),
      resume: (handle, config) => {
        const session = new RequesterLossSession(
          { ...config, provider: "codex", cwd: config.cwd ?? workdir },
          handle.metadata?.asyncQuestions,
        );
        const providerSession: AgentSession = session;
        providerSession.describePersistence = () => ({
          ...handle,
          metadata: { ...handle.metadata, asyncQuestions: session.questions.serialize() },
        });
        return session;
      },
    }),
  });
  const notify = observeAttentionNotifications(fixture.manager);
  return {
    manager: fixture.manager,
    storage: fixture.storage,
    timeline,
    client: fixture.client,
    notify,
    createAgent: (title: string, labels?: Record<string, string>) =>
      fixture.createAgent(title, labels),
  };
}

type RequesterLossFixture = ReturnType<typeof createRequesterLossFixture>;
type RequesterLossWorker = Awaited<ReturnType<RequesterLossFixture["createAgent"]>>;

/** Observe the actual provider start before test output, including when availability is held. */
async function startRequesterLossWork(input: {
  fixture: RequesterLossFixture;
  worker: RequesterLossWorker;
  options: AgentRunOptions;
  flush?: boolean;
}) {
  const { fixture, worker } = input;
  const turnId = `active-turn-${worker.session.startCount + 1}`;
  const started = deferred<void>();
  const unsubscribe = worker.session.subscribe((event) => {
    if (event.type === "turn_started" && event.turnId === turnId) started.resolve();
  });
  try {
    const result = await startAttentionRegressionTurn({
      manager: fixture.manager,
      agentId: worker.id,
      options: input.options,
      flush: false,
    });
    await started.promise;
    if (input.flush !== false) await fixture.manager.flush();
    expect(fixture.manager.getAgent(worker.id)?.activeTurnId).toBe(turnId);
    return { ...result, turnId };
  } finally {
    unsubscribe();
  }
}

/** Ordinary agent messages intentionally have no linked request ledger to derive membership from. */
function requesterLossOptions(requester: AgentAttentionPeer, requestId: string): AgentRunOptions {
  return { clientMessageId: requestId, attention: [{ kind: "agent", requester, requestId }] };
}

function requestRequesterLossPermission(
  worker: RequesterLossWorker,
  id: string,
): AgentPermissionRequest {
  const request = { id, provider: "codex", kind: "tool", name: "Deploy" } as const;
  worker.session.pushEvent({
    type: "permission_requested",
    provider: "codex",
    turnId: `active-turn-${worker.session.startCount}`,
    request,
  });
  return request;
}

/** Verify status remains primary while the orphan escalation is durable and opens this exact chat. */
async function expectRequesterLossAttention(
  fixture: RequesterLossFixture,
  worker: RequesterLossWorker,
): Promise<void> {
  const snapshot = fixture.manager.getAgent(worker.id);
  if (!snapshot) throw new Error("Expected the surviving blocked worker");
  const payload = toAgentPayload(snapshot);
  expect(
    deriveAgentStateBucket({
      ...payload,
      pendingPermissionCount: payload.pendingPermissions.length,
    }),
  ).toBe("needs_input");
  expect(payload.humanAttentionRequired).toBe(true);
  const message = REQUESTER_LOST_PERMISSION_MESSAGE;
  expect(fixture.notify).toHaveBeenCalledExactlyOnceWith({
    agentId: worker.id,
    provider: "codex",
    reason: "finished",
    message,
  });
  expect(await fixture.storage.get(worker.id)).toEqual(
    expect.objectContaining({ id: worker.id, requiresAttention: true, attentionMessage: message }),
  );
  await fixture.manager.flush();
  expect(fixture.notify).toHaveBeenCalledTimes(1);
}

test("requester loss committed archive survives provider close failure", async () => {
  const fixture = createRequesterLossFixture("archive-close-failure");
  const { manager, storage, notify } = fixture;
  const requester = await fixture.createAgent("Requester");
  const worker = await fixture.createAgent("Independent worker");
  await startRequesterLossWork({
    fixture,
    worker,
    options: requesterLossOptions(manager.attentionRequester(requester.id), "close-failure-job"),
  });
  const permission = requestRequesterLossPermission(worker, "close-failure-permission");
  await manager.flush();
  expect(notify).not.toHaveBeenCalled();
  const pushed = vi.spyOn(worker.session, "pushEvent");
  const failure = new Error("Requester provider close failed after archive committed");
  const close = vi.spyOn(requester.session, "close").mockRejectedValueOnce(failure);
  onTestFinished(() => close.mockRestore());
  await expect(manager.archiveAgent(requester.id)).rejects.toBe(failure);
  await manager.flush();
  expect(await storage.get(requester.id)).toEqual(
    expect.objectContaining({ id: requester.id, archivedAt: expect.any(String) }),
  );
  expect(manager.getAgent(requester.id)?.session).toBe(requester.session);
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(permission);
  expect(pushed).not.toHaveBeenCalled();
  await expectRequesterLossAttention(fixture, worker);
});

test("requester loss committed cascade survives timeline cleanup failure", async () => {
  const fixture = createRequesterLossFixture("cascade-cleanup-failure");
  const { manager, storage, timeline, notify } = fixture;
  const parent = await fixture.createAgent("Parent requester");
  const child = await fixture.createAgent("Attached requester and blocked worker", {
    [PARENT_AGENT_ID_LABEL]: parent.id,
  });
  const worker = await fixture.createAgent("Independent worker of the child");
  await startRequesterLossWork({
    fixture,
    worker: child,
    options: requesterLossOptions(manager.attentionRequester(parent.id), "child-job"),
  });
  requestRequesterLossPermission(child, "child-permission");
  await startRequesterLossWork({
    fixture,
    worker,
    options: requesterLossOptions(manager.attentionRequester(child.id), "surviving-job"),
  });
  const permission = requestRequesterLossPermission(worker, "surviving-permission");
  await manager.flush();
  expect(notify).not.toHaveBeenCalled();
  const pushed = vi.spyOn(worker.session, "pushEvent");
  const failure = new Error("Child timeline cleanup failed after cascade archive committed");
  const originalDelete = timeline.delete.bind(timeline);
  let failed = false;
  const cleanup = vi.spyOn(timeline, "delete").mockImplementation((agentId) => {
    if (agentId === child.id && !failed) {
      failed = true;
      throw failure;
    }
    originalDelete(agentId);
  });
  onTestFinished(() => cleanup.mockRestore());
  await expect(manager.archiveAgent(parent.id)).rejects.toBe(failure);
  await manager.flush();
  expect(failed).toBe(true);
  for (const id of [parent.id, child.id]) {
    expect(await storage.get(id)).toEqual(
      expect.objectContaining({ id, archivedAt: expect.any(String) }),
    );
    expect(manager.getAgent(id)).toBeNull();
  }
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(permission);
  expect(pushed).not.toHaveBeenCalled();
  await expectRequesterLossAttention(fixture, worker);
});

test("requester loss unresolved permission survives an actual plan terminal", async () => {
  const fixture = createRequesterLossFixture("unresolved-plan-terminal");
  const { manager, storage, notify } = fixture;
  const requester = await fixture.createAgent("Requester");
  const worker = await fixture.createAgent("Plan worker");
  const { running, turnId } = await startRequesterLossWork({
    fixture,
    worker,
    options: requesterLossOptions(manager.attentionRequester(requester.id), "unresolved-plan-job"),
  });
  const question = worker.session.requestQuestion("unresolved-plan");
  worker.session.pushEvent({ type: "turn_completed", provider: "codex", turnId });
  await running;
  await manager.flush();
  expect(manager.getAgent(worker.id)?.lifecycle).toBe("idle");
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(question.id)).toEqual(question);
  expect(worker.session.questions.hasPending(question.id)).toBe(true);
  expect(notify).not.toHaveBeenCalled();
  const pushed = vi.spyOn(worker.session, "pushEvent");
  const archived = await manager.archiveAgent(requester.id);
  await manager.flush();
  expect((await storage.get(requester.id))?.archivedAt).toBe(archived.archivedAt);
  expect(pushed).not.toHaveBeenCalled();
  await expectRequesterLossAttention(fixture, worker);
});

test("requester loss earlier checkpoint is not suppressed by an available later steer", async () => {
  const fixture = createRequesterLossFixture("earlier-checkpoint-membership");
  const { manager, storage, notify } = fixture;
  const firstRequester = await fixture.createAgent("Requester A");
  const secondRequester = await fixture.createAgent("Requester B");
  const worker = await fixture.createAgent("Shared SDK worker");
  for (const [requester, job] of [
    [firstRequester, "source-A"],
    [secondRequester, "source-B"],
  ] as const) {
    await startRequesterLossWork({ fixture, worker: requester, options: { clientMessageId: job } });
    await manager.reportObjectiveStatus({
      agentId: requester.id,
      objectiveId: job,
      disposition: "waiting",
    });
  }
  const firstAttention = await manager.prepareAttentionMessage({
    agentId: firstRequester.id,
    recipient: { agentId: worker.id },
  });
  const secondAttention = await manager.prepareAttentionMessage({
    agentId: secondRequester.id,
    recipient: { agentId: worker.id },
  });
  const firstLink = firstAttention?.requesterObjective;
  const secondLink = secondAttention?.requesterObjective;
  if (!firstLink || !secondLink) throw new Error("Expected independent exact A/B requester links");
  const peerA = manager.attentionRequester(firstRequester.id);
  const peerB = manager.attentionRequester(secondRequester.id);
  const { turnId } = await startRequesterLossWork({
    fixture,
    worker,
    options: {
      clientMessageId: firstLink.requestId,
      attention: [
        {
          kind: "agent",
          requestId: firstLink.requestId,
          requester: peerA,
          attention: firstAttention,
        },
      ],
    },
  });
  const permission = requestRequesterLossPermission(worker, "permission-owned-by-A");
  await manager.flush();
  expect(notify).not.toHaveBeenCalled();
  expect(
    await manager.steerAgentRun(worker.id, "A different request from B", {
      clientMessageId: secondLink.requestId,
      attention: [
        {
          kind: "agent",
          requestId: secondLink.requestId,
          requester: peerB,
          attention: secondAttention,
        },
      ],
    }),
  ).toEqual({ status: "accepted" });
  await manager.flush();
  expect(manager.getAgent(worker.id)?.activeTurnId).toBe(turnId);
  expect(worker.session.startCount).toBe(1);
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(permission);
  expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
    expect.objectContaining({
      link: firstLink,
      requester: peerA,
      outcomes: [
        expect.objectContaining({ kind: "permission", permission, acceptedTurnId: turnId }),
      ],
    }),
    expect.objectContaining({ link: secondLink, requester: peerB, outcomes: [] }),
  ]);
  const pushed = vi.spyOn(worker.session, "pushEvent");
  const archived = await manager.archiveAgent(firstRequester.id);
  await manager.flush();
  expect((await storage.get(firstRequester.id))?.archivedAt).toBe(archived.archivedAt);
  expect(await storage.get(secondRequester.id)).toEqual(
    expect.objectContaining({ id: secondRequester.id }),
  );
  expect((await storage.get(secondRequester.id))?.archivedAt).toBeUndefined();
  expect(pushed).not.toHaveBeenCalled();
  await expectRequesterLossAttention(fixture, worker);
  const message = REQUESTER_LOST_PERMISSION_MESSAGE;
  expect((await storage.get(worker.id))?.attentionObjectives?.objectives).toEqual([
    expect.objectContaining({
      id: firstLink.requestId,
      audience: { kind: "agent", requester: peerA },
      announcedReasons: [message],
    }),
    expect.objectContaining({
      id: secondLink.requestId,
      audience: { kind: "agent", requester: peerB },
      announcedReasons: [],
    }),
  ]);
  expect(
    (await storage.get(worker.id))?.attentionObjectives?.requests?.records?.[1]?.outcomes,
  ).toEqual([]);
});

/**
 * A worker blocked on a permission for a remote requester whose first availability check is
 * held. Tests change the blocker while the check is pending, then release it as "missing".
 */
async function startStaleRequesterLossCheck(name: string) {
  const fixture = createRequesterLossFixture(`stale-${name}`);
  const { manager, notify } = fixture;
  const requester = await fixture.createAgent("Requester identity");
  const worker = await fixture.createAgent("Blocked worker");
  const entered = deferred<void>();
  const release = deferred<void>();
  const resolveRequester = vi
    .fn<(peer: AgentAttentionPeer) => Promise<"available" | "missing" | "unknown">>()
    .mockResolvedValue("available")
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return "missing";
    });
  manager.setAttentionHost({ serverId: "local", resolveRemoteRequester: resolveRequester });
  const remote = { agentId: requester.id, serverId: "remote" };
  const original = await startRequesterLossWork({
    fixture,
    worker,
    options: requesterLossOptions(remote, "held-job"),
  });
  const permission = requestRequesterLossPermission(worker, "reused-checkpoint");
  onTestFinished(() => release.resolve());
  await entered.promise;
  expect(notify).not.toHaveBeenCalled();

  /** Release the held check and prove the stale checkpoint published nothing. */
  async function expectStaleCheckDidNotPublish() {
    release.resolve();
    await manager.flush();
    expect(resolveRequester).toHaveBeenNthCalledWith(1, remote);
    expect(notify).not.toHaveBeenCalled();
    const snapshot = manager.getAgent(worker.id);
    if (!snapshot) throw new Error("Expected the current worker after stale verification");
    expect(toAgentPayload(snapshot).humanAttentionRequired).toBe(false);
  }

  return {
    fixture,
    manager,
    worker,
    remote,
    original,
    permission,
    resolveRequester,
    release,
    expectStaleCheckDidNotPublish,
  };
}

test("requester loss stale resolved checkpoint cannot publish after availability resolves", async () => {
  const scenario = await startStaleRequesterLossCheck("resolved");
  const { manager, worker, original, permission } = scenario;
  try {
    worker.session.pushEvent({
      type: "permission_resolved",
      provider: "codex",
      turnId: original.turnId,
      requestId: permission.id,
      resolution: { behavior: "allow" },
    });
    await vi.waitFor(() => expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(0));
  } finally {
    scenario.release.resolve();
  }
  await scenario.expectStaleCheckDidNotPublish();
});

test.each([
  {
    variant: "replaced",
    requestId: "replacement-job",
    nextPermissionId: (_original: string) => "replacement-permission",
  },
  { variant: "reused-id", requestId: "held-job", nextPermissionId: (original: string) => original },
])(
  "requester loss stale $variant checkpoint cannot publish after availability resolves",
  async ({ variant, requestId, nextPermissionId }) => {
    const scenario = await startStaleRequesterLossCheck(variant);
    const { fixture, manager, worker, remote, original, permission } = scenario;
    try {
      await manager.cancelAgentRun(worker.id);
      await original.running;
      const replacement = await startRequesterLossWork({
        fixture,
        worker,
        options: requesterLossOptions(remote, requestId),
        flush: false,
      });
      expect(replacement.turnId).not.toBe(original.turnId);
      const nextPermission = requestRequesterLossPermission(
        worker,
        nextPermissionId(permission.id),
      );
      await vi.waitFor(() => expect(scenario.resolveRequester).toHaveBeenCalledTimes(2));
      expect(manager.getAgent(worker.id)?.pendingPermissions.get(nextPermission.id)).toEqual(
        nextPermission,
      );
      expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([requestId]);
    } finally {
      scenario.release.resolve();
    }
    await scenario.expectStaleCheckDidNotPublish();
  },
);

test("requester loss ordinary close keeps the blocked requester resumable", async () => {
  const fixture = createRequesterLossFixture("ordinary-close");
  const { manager, storage, notify } = fixture;
  const requester = await fixture.createAgent("Resumable requester");
  const worker = await fixture.createAgent("Blocked worker");
  await startRequesterLossWork({
    fixture,
    worker,
    options: requesterLossOptions(manager.attentionRequester(requester.id), "resumable-request"),
  });
  const permission = requestRequesterLossPermission(worker, "resumable-permission");
  await manager.flush();
  expect(notify).not.toHaveBeenCalled();
  const pushed = vi.spyOn(worker.session, "pushEvent");
  await manager.closeAgent(requester.id);
  await manager.flush();
  expect(manager.getAgent(requester.id)).toBeNull();
  expect(await storage.get(requester.id)).toEqual(expect.objectContaining({ id: requester.id }));
  expect((await storage.get(requester.id))?.archivedAt).toBeUndefined();
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(permission);
  expect(pushed).not.toHaveBeenCalled();
  const snapshot = manager.getAgent(worker.id);
  if (!snapshot) throw new Error("Expected the still-blocked worker");
  expect(toAgentPayload(snapshot).humanAttentionRequired).toBe(false);
  expect(notify).not.toHaveBeenCalled();
});

test("requester loss same UUID on another host ignores a local archive", async () => {
  const fixture = createRequesterLossFixture("same-UUID-remote");
  const { manager, storage, notify } = fixture;
  const requester = await fixture.createAgent("Unrelated local UUID");
  const worker = await fixture.createAgent("Remote-owned worker");
  const resolveRequester = vi
    .fn<(peer: AgentAttentionPeer) => Promise<"available" | "missing" | "unknown">>()
    .mockResolvedValue("available");
  manager.setAttentionHost({ serverId: "local", resolveRemoteRequester: resolveRequester });
  const remote = { agentId: requester.id, serverId: "remote" };
  await startRequesterLossWork({
    fixture,
    worker,
    options: requesterLossOptions(remote, "remote-request"),
  });
  const permission = requestRequesterLossPermission(worker, "remote-permission");
  await manager.flush();
  expect(resolveRequester).toHaveBeenCalledExactlyOnceWith(remote);
  expect(notify).not.toHaveBeenCalled();
  await manager.archiveAgent(requester.id);
  await manager.flush();
  expect(await storage.get(requester.id)).toEqual(
    expect.objectContaining({ id: requester.id, archivedAt: expect.any(String) }),
  );
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(permission);
  expect(resolveRequester).toHaveBeenCalledExactlyOnceWith(remote);
  const snapshot = manager.getAgent(worker.id);
  if (!snapshot) throw new Error("Expected the remote-owned current worker");
  expect(toAgentPayload(snapshot).humanAttentionRequired).toBe(false);
  expect(notify).not.toHaveBeenCalled();
});

test.each([
  {
    variant: "current",
    // The question is still unanswered, so it is the restored worker's current blocker.
    answerBeforeClose: async () => {},
    stillBlocked: true,
    pendingAfterRestore: (question: AgentPermissionRequest) => [question],
    notificationsAfterLoss: (loss: Parameters<AgentAttentionCallback>[0]) => [loss],
  },
  {
    variant: "historical",
    // Answered before close, the question is history and cannot block after restore.
    answerBeforeClose: async (manager: AgentManager, workerId: string, questionId: string) => {
      await manager.respondToPermission(workerId, questionId, { behavior: "deny" });
      await manager.flush();
    },
    stillBlocked: false,
    pendingAfterRestore: (_question: AgentPermissionRequest) => [],
    notificationsAfterLoss: (_loss: Parameters<AgentAttentionCallback>[0]) => [],
  },
])(
  "requester loss restored $variant question waits for committed loss and current blocker",
  async ({
    variant,
    answerBeforeClose,
    stillBlocked,
    pendingAfterRestore,
    notificationsAfterLoss,
  }) => {
    const fixture = createRequesterLossFixture(`restored-${variant}`);
    const { manager, storage, client, notify } = fixture;
    const requester = await fixture.createAgent("Requester");
    const worker = await fixture.createAgent("Restored worker");
    const { running, turnId } = await startRequesterLossWork({
      fixture,
      worker,
      options: requesterLossOptions(manager.attentionRequester(requester.id), "restored-request"),
    });
    await manager.reportObjectiveStatus({
      agentId: worker.id,
      objectiveId: "restored-request",
      disposition: "waiting",
    });
    const question = worker.session.requestQuestion("restored-question");
    worker.session.pushEvent({ type: "turn_completed", provider: "codex", turnId });
    await running;
    await manager.flush();
    await answerBeforeClose(manager, worker.id, question.id);
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
      "restored-request",
    ]);
    expect(notify).not.toHaveBeenCalled();
    const beforeClose = await storage.get(worker.id);
    if (!beforeClose?.persistence) throw new Error("Expected the real question persistence handle");
    expect(beforeClose.persistence.metadata?.asyncQuestions).toEqual(
      worker.session.questions.serialize(),
    );
    await manager.closeAgent(worker.id);
    await manager.flush();
    expect(manager.getAgent(worker.id)).toBeNull();
    const restoredPermissions: AgentPermissionRequest[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "permission_requested")
          restoredPermissions.push(event.event.request);
      },
      { agentId: worker.id, replayState: false },
    );
    onTestFinished(unsubscribe);
    const restored = await ensureAgentLoaded(worker.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await manager.flush();
    const resumedSession = client.sessions.at(-1);
    if (!resumedSession) throw new Error("Expected the actual restored provider session");
    expect(restored.session).toBe(resumedSession);
    expect(resumedSession).not.toBe(worker.session);
    expect(client.resumedHandles).toEqual([
      expect.objectContaining({
        sessionId: beforeClose.persistence.sessionId,
        metadata: expect.objectContaining({
          asyncQuestions: beforeClose.persistence.metadata?.asyncQuestions,
        }),
      }),
    ]);
    expect(restoredPermissions).toEqual([]);
    const expectedPending = pendingAfterRestore(question);
    expect(resumedSession.getPendingPermissions()).toEqual(expectedPending);
    expect(manager.getPendingPermissions(worker.id)).toEqual(expectedPending);
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
      "restored-request",
    ]);
    expect(toAgentPayload(restored).humanAttentionRequired).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    const pushed = vi.spyOn(resumedSession, "pushEvent");
    const archived = await manager.archiveAgent(requester.id);
    await manager.flush();
    expect((await storage.get(requester.id))?.archivedAt).toBe(archived.archivedAt);
    expect(pushed).not.toHaveBeenCalled();
    expect(manager.getPendingPermissions(worker.id)).toEqual(expectedPending);
    const current = manager.getAgent(worker.id);
    if (!current) throw new Error("Expected the resident restored worker");
    expect(toAgentPayload(current).humanAttentionRequired).toBe(stillBlocked);
    const lossNotification: Parameters<AgentAttentionCallback>[0] = {
      agentId: worker.id,
      provider: "codex",
      reason: "finished",
      message: REQUESTER_LOST_PERMISSION_MESSAGE,
    };
    expect(notify.mock.calls.map(([event]) => event)).toEqual(
      notificationsAfterLoss(lossNotification),
    );
    expect((await storage.get(worker.id))?.requiresAttention).toBe(stillBlocked);
  },
);

test("permission host binding retains a held accepted response completion", async () => {
  const fixture = createAttentionRegressionFixture("permission-host-binding");
  const { manager, storage } = fixture;
  const requester = await fixture.createAgent("Requester");
  const worker = await fixture.createAgent("Worker");
  const notify = observeAttentionNotifications(manager);
  const { attention, link, requesterPeer } = await delegateFromHumanObjective({
    manager,
    requesterId: requester.id,
    recipientId: worker.id,
    objectiveId: "host-binding-human-job",
  });
  const { running } = await startAttentionRegressionTurn({
    manager,
    agentId: worker.id,
    nativeStart: { session: worker.session, turnId: worker.session.turnId },
    options: {
      clientMessageId: link.requestId,
      attention: [
        { kind: "agent", requestId: link.requestId, requester: requesterPeer, attention },
      ],
    },
  });
  const turnId = worker.session.turnId;
  const permission = {
    id: "host-binding-permission",
    provider: "codex",
    kind: "tool",
    name: "Run",
  } as const;
  worker.session.pushEvent({
    type: "permission_requested",
    provider: "codex",
    turnId,
    request: permission,
  });
  await manager.flush();
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(permission);
  expect(notify).not.toHaveBeenCalled();

  const responseEntered = deferred<void>();
  const releaseResponse = deferred<void>();
  const providerResponse = vi
    .spyOn(worker.session, "respondToPermission")
    .mockImplementation(async () => {
      responseEntered.resolve();
      await releaseResponse.promise;
    });
  const extraStart = vi.spyOn(worker.session, "startTurn");
  const response = { behavior: "allow" } as const;
  const responding = manager.respondToPermission(worker.id, permission.id, response);
  void responding.catch(() => undefined);
  try {
    await responseEntered.promise;
    expect(providerResponse).toHaveBeenCalledExactlyOnceWith(permission.id, response);
    expect(manager.getAgent(worker.id)?.inFlightPermissionResponses.has(permission.id)).toBe(true);
    manager.setAttentionHost({
      serverId: "host-qualified-after-acceptance",
      resolveRemoteRequester: async () => "unknown",
    });
    expect(manager.getAgent(worker.id)?.inFlightPermissionResponses.has(permission.id)).toBe(true);
    expect(manager.getAttentionObjectives(worker.id)).toEqual({
      activeObjectiveIds: [link.requestId],
      objectives: [
        {
          id: link.requestId,
          audience: { kind: "agent", requester: requesterPeer },
          disposition: "normal",
        },
      ],
    });
    worker.session.pushEvent({
      type: "permission_resolved",
      provider: "codex",
      turnId,
      requestId: permission.id,
      resolution: response,
    });
    worker.session.pushEvent({
      type: "timeline",
      provider: "codex",
      turnId,
      item: { type: "assistant_message", text: "Exact final response across host binding" },
    });
    worker.session.pushEvent({ type: "turn_completed", provider: "codex", turnId });
    await running;
    await manager.flush();
    expect(manager.getAgent(worker.id)?.lifecycle).toBe("idle");
    expect(manager.getAgent(worker.id)?.pendingPermissions.size).toBe(0);
    expect(manager.getAgent(worker.id)?.inFlightPermissionResponses.has(permission.id)).toBe(true);
    expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([link.requestId]);
    expect(notify).not.toHaveBeenCalled();
  } finally {
    releaseResponse.resolve();
    await responding;
    providerResponse.mockRestore();
  }
  await manager.flush();
  expect(await manager.getLastAssistantMessage(worker.id)).toBe(
    "Exact final response across host binding",
  );
  expect((await storage.get(worker.id))?.attentionObjectives?.requests?.records).toEqual([
    expect.objectContaining({
      link,
      requester: requesterPeer,
      turnId,
      active: false,
      outcomes: [
        expect.objectContaining({ kind: "permission", permission, acceptedTurnId: turnId }),
        expect.objectContaining({
          kind: "finished",
          requestId: link.requestId,
          acceptedTurnId: turnId,
          lastMessage: "Exact final response across host binding",
          error: null,
        }),
      ],
    }),
  ]);
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([]);
  const snapshot = manager.getAgent(worker.id);
  if (!snapshot) throw new Error("Expected the completed worker to remain loaded");
  expect(snapshot.inFlightPermissionResponses.size).toBe(0);
  expect(toAgentPayload(snapshot).humanAttentionRequired).toBe(false);
  expect(extraStart).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
});

test("requester availability epoch retires an old result across same-host setup", async () => {
  const fixture = createRequesterLossFixture("availability-epoch");
  const { manager, notify } = fixture;
  const requester = await fixture.createAgent("Remote requester identity");
  const worker = await fixture.createAgent("Blocked worker");
  const entered = deferred<void>();
  const release = deferred<void>();
  const originalResolver = vi
    .fn<(peer: AgentAttentionPeer) => Promise<"available" | "missing" | "unknown">>()
    .mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return "missing";
    });
  const currentResolver = vi
    .fn<(peer: AgentAttentionPeer) => Promise<"available" | "missing" | "unknown">>()
    .mockResolvedValue("available");
  manager.setAttentionHost({ serverId: "local", resolveRemoteRequester: originalResolver });
  const remote = { agentId: requester.id, serverId: "remote" };
  const { turnId } = await startRequesterLossWork({
    fixture,
    worker,
    options: requesterLossOptions(remote, "same-host-setup-job"),
  });
  const permission = requestRequesterLossPermission(worker, "old-context-permission");
  onTestFinished(() => release.resolve());
  try {
    await entered.promise;
    expect(originalResolver).toHaveBeenCalledExactlyOnceWith(remote);
    expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(permission);
    manager.setAttentionHost({ serverId: "local", resolveRemoteRequester: currentResolver });
    expect(currentResolver).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await manager.flush();
  // The existing blocker and accepted turn remain live; binding itself schedules no new lookup.
  expect(currentResolver).not.toHaveBeenCalled();
  expect(manager.getAgent(worker.id)?.activeTurnId).toBe(turnId);
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
    "same-host-setup-job",
  ]);
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(permission.id)).toEqual(permission);
  expect(worker.session.startCount).toBe(1);
  expect(notify).not.toHaveBeenCalled();
  const afterBinding = manager.getAgent(worker.id);
  if (!afterBinding) throw new Error("Expected the original still-blocked worker");
  expect(toAgentPayload(afterBinding).humanAttentionRequired).toBe(false);

  const nextPermission = requestRequesterLossPermission(worker, "current-context-permission");
  await manager.flush();
  expect(currentResolver).toHaveBeenCalledWith(remote);
  expect(originalResolver).toHaveBeenCalledTimes(1);
  expect(manager.getAgent(worker.id)?.pendingPermissions.get(nextPermission.id)).toEqual(
    nextPermission,
  );
  expect(manager.getAgent(worker.id)?.activeTurnId).toBe(turnId);
  expect(manager.getAttentionObjectives(worker.id).activeObjectiveIds).toEqual([
    "same-host-setup-job",
  ]);
  expect(worker.session.startCount).toBe(1);
  const current = manager.getAgent(worker.id);
  if (!current) throw new Error("Expected the current worker after its next actual permission");
  expect(toAgentPayload(current).humanAttentionRequired).toBe(false);
  expect(notify).not.toHaveBeenCalled();
});

test.each([
  { enabled: true, delegated: false, permission: false },
  { enabled: false, delegated: false, permission: false },
  { enabled: true, delegated: true, permission: false },
  { enabled: false, delegated: true, permission: false },
  { enabled: true, delegated: false, permission: true },
  { enabled: false, delegated: false, permission: true },
  { enabled: true, delegated: true, permission: true },
  { enabled: false, delegated: true, permission: true },
])(
  "attention mode $enabled delegated $delegated permission $permission preserves exact recipient",
  async ({ enabled, delegated, permission }) => {
    const fixture = createAttentionRegressionFixture("mode-recipient");
    const { manager, storage } = fixture;
    const requester = await fixture.createAgent("Requester");
    const worker = await fixture.createAgent("Worker");
    if (delegated) await manager.setLabels(worker.id, { "paseo.parent-agent-id": requester.id });
    const notify = observeAttentionNotifications(manager);
    const { attention, link, requesterPeer } = await delegateFromHumanObjective({
      manager,
      requesterId: requester.id,
      recipientId: worker.id,
      objectiveId: "mode-human-job",
    });
    const { running } = await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      nativeStart: { session: worker.session, turnId: worker.session.turnId },
      options: {
        clientMessageId: link.requestId,
        attention: [
          { kind: "agent", requestId: link.requestId, requester: requesterPeer, attention },
        ],
      },
    });
    const before = (await storage.get(worker.id))?.attentionObjectives;
    manager.setAttentionPresentationEnabled(enabled);
    expect(notify).not.toHaveBeenCalled();
    expect((await storage.get(worker.id))?.attentionObjectives).toEqual(before);
    if (permission) {
      worker.session.pushEvent({
        type: "permission_requested",
        provider: "codex",
        turnId: worker.session.turnId,
        request: { id: "mode-permission", name: "Run", kind: "tool" },
      });
    } else {
      worker.session.pushEvent({
        type: "timeline",
        provider: "codex",
        turnId: worker.session.turnId,
        item: { type: "assistant_message", text: "Exact mode result" },
      });
      worker.session.pushEvent({
        type: "turn_completed",
        provider: "codex",
        turnId: worker.session.turnId,
      });
      await running;
    }
    await manager.flush();
    const current = manager.getAgent(worker.id);
    if (!current) throw new Error("Expected the admitted worker");
    expect(toAgentPayload(current).humanAttentionRequired).toBe(enabled ? false : undefined);
    expect(notify.mock.calls.map(([event]) => event.reason)).toEqual(
      !enabled && !delegated ? [permission ? "permission" : "finished"] : [],
    );
    expect(current.pendingPermissions.size).toBe(permission ? 1 : 0);
    const outcome = await manager.waitForAttentionOutcome({
      agentId: worker.id,
      query: { requester: requesterPeer, link },
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      requestId: link.requestId,
      requester: requesterPeer,
      acceptedTurnId: worker.session.turnId,
      kind: permission ? "permission" : "finished",
      lastMessage: permission ? null : "Exact mode result",
    });
    expect(manager.getAttentionObjectives(requester.id).activeObjectiveIds).toEqual([
      "mode-human-job",
    ]);
  },
);

test.each([true, false])(
  "attention mode %s keeps explicit child intervention durable and deduplicated",
  async (enabled) => {
    const fixture = createAttentionRegressionFixture("mode-child-safety");
    const { manager, storage } = fixture;
    const requester = await fixture.createAgent("Requester");
    const worker = await fixture.createAgent("Child worker");
    await manager.setLabels(worker.id, { "paseo.parent-agent-id": requester.id });
    manager.setAttentionPresentationEnabled(enabled);
    const notify = observeAttentionNotifications(manager);
    await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      nativeStart: { session: worker.session, turnId: worker.session.turnId },
      options: {
        attention: [
          {
            kind: "agent",
            requestId: "mode-safety",
            requester: manager.attentionRequester(requester.id),
          },
        ],
      },
    });
    const request = {
      agentId: worker.id,
      objectiveId: "mode-safety",
      reason: "Choose the account",
    };
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: true });
    expect(await manager.requestHumanAttention(request)).toEqual({ notified: false });
    const current = manager.getAgent(worker.id);
    if (!current) throw new Error("Expected the escalating child");
    expect(toAgentPayload(current).humanAttentionRequired).toBe(true);
    expectNotifiedOnce(notify, { agentId: worker.id, message: request.reason });
    const saved = await storage.get(worker.id);
    manager.setAttentionPresentationEnabled(!enabled);
    manager.setAttentionPresentationEnabled(enabled);
    expect(await storage.get(worker.id)).toEqual(saved);
    expect(notify).toHaveBeenCalledTimes(1);
  },
);

test.each([true, false])(
  "attention mode %s preserves verified orphan intervention without another worker event",
  async (enabled) => {
    const fixture = createAttentionRegressionFixture("mode-orphan-safety");
    const { manager, storage } = fixture;
    const requester = await fixture.createAgent("Requester");
    const worker = await fixture.createAgent("Independent worker");
    manager.setAttentionPresentationEnabled(enabled);
    const notify = observeAttentionNotifications(manager);
    await startAttentionRegressionTurn({
      manager,
      agentId: worker.id,
      nativeStart: { session: worker.session, turnId: worker.session.turnId },
      options: {
        attention: [
          {
            kind: "agent",
            requestId: "mode-orphan",
            requester: manager.attentionRequester(requester.id),
          },
        ],
      },
    });
    worker.session.pushEvent({
      type: "permission_requested",
      provider: "codex",
      turnId: worker.session.turnId,
      request: { id: "mode-blocker", name: "Run", kind: "tool" },
    });
    await manager.flush();
    notify.mockClear();
    const event = vi.spyOn(worker.session, "pushEvent");
    await manager.archiveAgent(requester.id);
    await manager.flush();
    expect(event).not.toHaveBeenCalled();
    expect(manager.getPendingPermissions(worker.id).map((permission) => permission.id)).toEqual([
      "mode-blocker",
    ]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: worker.id,
        reason: "finished",
        message: expect.stringContaining("requesting agent is no longer available"),
      }),
    );
    expect((await storage.get(worker.id))?.attentionMessage).toContain(
      "requesting agent is no longer available",
    );
  },
);

test("attention mode changes do not manufacture historical unread or erase manual unread", async () => {
  const fixture = createAttentionRegressionFixture("mode-prospective");
  const { manager, storage } = fixture;
  const requester = await fixture.createAgent("Requester");
  const worker = await fixture.createAgent("Quiet worker");
  const notify = observeAttentionNotifications(manager);
  const { running } = await startAttentionRegressionTurn({
    manager,
    agentId: worker.id,
    nativeStart: { session: worker.session, turnId: worker.session.turnId },
    options: {
      attention: [
        {
          kind: "agent",
          requestId: "mode-quiet",
          requester: manager.attentionRequester(requester.id),
        },
      ],
    },
  });
  worker.session.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: worker.session.turnId,
  });
  await running;
  await manager.flush();
  const quiet = await storage.get(worker.id);
  manager.setAttentionPresentationEnabled(false);
  expect(await storage.get(worker.id)).toEqual(quiet);
  expect(manager.getAgent(worker.id)?.attention.requiresAttention).toBe(false);
  await manager.markAgentUnread(worker.id);
  const manual = await storage.get(worker.id);
  manager.setAttentionPresentationEnabled(true);
  expect(await storage.get(worker.id)).toEqual(manual);
  expect(manager.getAgent(worker.id)?.attention.requiresAttention).toBe(true);
  expect(notify).not.toHaveBeenCalled();
});

test("a stored agent without a provider handle keeps its attention state when it loads", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "attention-load-without-handle-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const objectives = new AgentAttentionObjectives(undefined, "origin");
  objectives.admit({ inputs: [{ kind: "human", requestId: "human-job" }], steering: false });
  objectives.declare("human-job", "waiting");
  const link = objectives.outgoing({ recipient: { agentId: "worker", serverId: "origin" } });
  if (!link?.requesterObjective) throw new Error("Expected a delegation link");
  const expected = objectives.snapshot();

  // Provider startup failed before Claude or Codex returned a session handle, so the stored
  // record never gains a persistence handle or a native history binding.
  class HandlelessAgentClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const session = await super.createSession(config);
      session.describePersistence = () => null;
      return session;
    }
  }
  const first = new AgentManager({
    clients: { codex: new HandlelessAgentClient() },
    registry: storage,
    logger,
  });
  const created = await first.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
    attentionObjectives: expected,
  });
  await first.closeAgent(created.id);
  await first.flush();
  const stored = await storage.get(created.id);
  if (!stored) throw new Error("Expected the stored agent");
  const unreadAt = "2026-11-11T12:00:00.000Z";
  expect(stored.persistence ?? null).toBeNull();
  await storage.upsert({
    ...stored,
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: unreadAt,
    attentionMessage: "Choose the deployment account",
    humanAttentionRequired: true,
  });
  await storage.flush();

  const second = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  second.setAttentionHost({ serverId: "origin", resolveRemoteRequester: async () => "unknown" });
  const fromRecord = vi.spyOn(second, "createAgentFromRecord");
  const resume = vi.spyOn(second, "resumeAgentFromPersistence");
  onTestFinished(async () => {
    await second.closeAgent(created.id).catch(() => undefined);
    await second.flush();
    rmSync(workdir, { recursive: true, force: true });
  });

  const loaded = await ensureAgentLoaded(created.id, {
    agentManager: second,
    agentStorage: storage,
    logger,
  });

  expect(fromRecord).toHaveBeenCalledExactlyOnceWith(created.id);
  expect(resume).not.toHaveBeenCalled();
  expect(loaded.attentionObjectives?.describe()).toEqual(
    new AgentAttentionObjectives(expected).describe(),
  );
  expect(loaded.attentionObjectives?.snapshot().delegations).toEqual(expected.delegations);
  expect(loaded.attentionMessage).toBe("Choose the deployment account");
  expect(loaded.attention).toMatchObject({ requiresAttention: true, attentionReason: "finished" });
  expect(toAgentPayload(loaded)).toMatchObject({
    requiresAttention: true,
    humanAttentionRequired: true,
    attentionMessage: "Choose the deployment account",
  });
});

test("clearing a stored-only agent's attention also clears its request and Ready decision", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "attention-stored-clear-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const first = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  const created = await first.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  await first.closeAgent(created.id);
  await first.flush();
  const stored = await storage.get(created.id);
  if (!stored) throw new Error("Expected the stored agent");
  await storage.upsert({
    ...stored,
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: "2026-11-11T12:00:00.000Z",
    attentionMessage: "Choose the deployment account",
    humanAttentionRequired: true,
  });
  // A second manager has never loaded this agent, so the clear takes the stored-only path.
  const second = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  onTestFinished(async () => {
    await second.flush();
    rmSync(workdir, { recursive: true, force: true });
  });

  await second.clearAgentAttention(created.id);

  expect(second.getAgent(created.id)).toBeNull();
  expect(await storage.get(created.id)).toMatchObject({
    requiresAttention: false,
    attentionReason: null,
    attentionMessage: null,
    humanAttentionRequired: false,
  });
});
