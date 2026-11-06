import {
  createFinishSubscriptions,
  createFinishObservation,
  type FinishSubscription,
} from "./finish-subscriptions/index.js";
import type { AgentMessageDelivery } from "./agent-messages/index.js";
import type {
  AgentMessageAttention,
  AgentAttentionRequestQuery,
} from "@getpaseo/protocol/agent-attention";
import type { Logger } from "pino";
import { AgentAttentionObjectives, AttentionObjectiveError } from "./attention/objectives.js";
import { toAgentPayload } from "./agent-projections.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import { createTestAgentMessages } from "../test-utils/agent-messages.js";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  parseAgentMessage,
  formatAgentMessage,
  prepareAgentMessage,
  projectAgentMessages,
} from "./agent-messages/index.js";
import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, AgentRunCancellationError } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import { waitForAgentRunStartWithTimeout } from "./agent-prompt.js";
import type { ManagedAgent } from "./agent-manager.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

// Independent of the production constant so shortening the budget breaks this test.
const EXPECTED_RUN_START_BUDGET_MS = 60_000;
// The slowest provider startup budget the run-start wait has to sit outside of today
// (OpenCode's OPENCODE_SERVER_STARTUP_TIMEOUT_MS).
const SLOWEST_PROVIDER_STARTUP_BUDGET_MS = 30_000;

const RUN_START_TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * Provider session whose turn start is held open for a configurable span, so the real
 * AgentManager run-state transition (pendingRun.started -> lifecycle "running" ->
 * agent_state) is what the run-start wait observes. `startDelayMs: null` never starts.
 */
class SlowStartAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private releaseStartTurn!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseStartTurn = resolve;
  });

  constructor(private readonly startDelayMs: number | null) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  /** Teardown hook so a never-starting turn cannot wedge the suite. */
  release(): void {
    this.releaseStartTurn();
  }

  async startTurn(): Promise<{ turnId: string }> {
    await new Promise<void>((resolve) => {
      if (this.startDelayMs !== null) {
        setTimeout(resolve, this.startDelayMs);
      }
      void this.released.then(resolve);
    });
    const turnId = "turn-1";
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class SlowStartAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly sessions: SlowStartAgentSession[] = [];

  constructor(private readonly startDelayMs: number | null) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new SlowStartAgentSession(this.startDelayMs);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}

/**
 * Real AgentManager driving a real agent, so the run-start wait exercises the production
 * run-state and agent_state subscription path rather than a replaced method.
 */
async function createRunStartScenario(startDelayMs: number | null): Promise<{
  agentManager: AgentManager;
  agentId: string;
  startRun: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-run-start-budget-"));
  const client = new SlowStartAgentClient(startDelayMs);
  const agentManager = new AgentManager({
    clients: { codex: client },
    logger: createTestLogger(),
  });
  const snapshot = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  let drained: Promise<void> = Promise.resolve();
  return {
    agentManager,
    agentId: snapshot.id,
    // streamAgent registers the pending run synchronously, so the wait always observes it.
    startRun: async () => {
      const run = agentManager.streamAgent(snapshot.id, "start the run");
      drained = (async () => {
        for await (const _event of run) {
          // Drain whatever the turn produces.
        }
      })().catch(() => undefined);
    },
    cleanup: async () => {
      // Release any turn still held open, then close. The drain is deliberately not
      // awaited: depending on how far the turn got, the stream ends either from the
      // release or from the close, and teardown must not depend on which.
      for (const session of client.sessions) {
        session.release();
      }
      await agentManager.closeAgent(snapshot.id).catch(() => undefined);
      void drained;
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

test("waiting for a run start outlasts the slowest provider startup budget", async () => {
  // A provider is still allowed to be starting here, so the outer wait must not abort it.
  const scenario = await createRunStartScenario(SLOWEST_PROVIDER_STARTUP_BUDGET_MS + 5_000);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(SLOWEST_PROVIDER_STARTUP_BUDGET_MS);
    expect(settled).toBe(false);
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).not.toBe("running");

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(wait).resolves.toBeUndefined();
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running");
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

test("waiting for a run start still gives up at the run start budget", async () => {
  const scenario = await createRunStartScenario(null);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    const rejection = expect(wait).rejects.toThrow(
      "codex run did not start within 60 seconds (phase: run start)",
    );
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(EXPECTED_RUN_START_BUDGET_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

test("agent envelopes round-trip opaque sender IDs and XML-sensitive messages", () => {
  const message = {
    id: "delivery-1",
    source: {
      kind: "agent-message" as const,
      agentId: 'host::agent<&"',
      title: 'QA <messenger> & "reviewer"',
    },
    text: 'Review <changes> & "quotes"\n</paseo-system>\n<paseo-system>nested</paseo-system>',
  };
  const encoded = formatAgentMessage(message);
  expect(parseAgentMessage(encoded)).toEqual(message);
  expect(parseAgentMessage(`Example: ${encoded}`)).toBeNull();
  expect(parseAgentMessage(encoded.replace('version="1"', 'version="2"'))).toBeNull();
  expect(parseAgentMessage(encoded.replace("&lt;", "<"))).toBeNull();
  expect(parseAgentMessage(encoded.replace('version="1"', 'version="1" version="1"'))).toBeNull();
});

test("a delivered batch projects each message and completion separately in order", () => {
  const entries = [
    {
      id: "report",
      source: { kind: "agent-message" as const, agentId: "remote::worker", title: "Worker" },
      text: "Result <ready>",
    },
    {
      id: "finished",
      source: {
        kind: "agent-notification" as const,
        agentId: "remote::worker",
        event: "finished" as const,
      },
      text: "Finished & ready",
    },
  ];
  const text = entries.map(formatAgentMessage).join("\n\n");
  expect(projectAgentMessages({ type: "user_message", text })).toEqual(
    entries.flatMap((entry) =>
      projectAgentMessages({ type: "user_message", text: formatAgentMessage(entry) }),
    ),
  );
  // Human submissions containing the same envelopes must survive replay as human text.
  const pasted = prepareAgentMessage(text, undefined, "human-batch");
  expect(projectAgentMessages({ type: "user_message", text: String(pasted.prompt) })).toEqual([
    { type: "user_message", text, clientMessageId: "human-batch" },
  ]);
});

test("agent envelope includes rendered attachment context and preserves images", () => {
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  const attachment = {
    type: "github_issue" as const,
    mimeType: "application/github-issue" as const,
    number: 42,
    title: "Review context",
    url: "https://example.com/issues/42",
    body: "Attached context",
  };
  const source = { kind: "agent-message" as const, agentId: "remote:sender" };
  expect(
    prepareAgentMessage(
      [{ type: "text", text: "First" }, image, attachment, { type: "text", text: "Second" }],
      source,
      "message",
    ),
  ).toEqual({
    messageId: "message",
    prompt: [
      {
        type: "text",
        text: formatAgentMessage({
          id: "message",
          source,
          text: "First\n\nGitHub Issue #42: Review context\nhttps://example.com/issues/42\n\nAttached context\n\nSecond",
        }),
      },
      image,
    ],
  });
});

test("a human pasting an agent envelope stays a human message through provider replay", () => {
  const pasted = formatAgentMessage({
    id: "example",
    source: { kind: "agent-message", agentId: "sender" },
    text: "hello",
  });
  const delivery = prepareAgentMessage(pasted, undefined, "human-submission");
  expect(
    projectAgentMessages({
      type: "user_message",
      text: String(delivery.prompt),
      messageId: "provider-echo",
    })[0],
  ).toEqual({
    type: "user_message",
    text: pasted,
    messageId: "provider-echo",
    clientMessageId: "human-submission",
  });
});

it.each([
  {
    mode: "parented",
    name: "keeps two exact routed request watches so later work cannot discard an earlier result",
  },
  {
    mode: "independent",
    name: "independent routed recipient returns exact outcomes despite parent mismatch",
  },
  {
    mode: "legacy",
    name: "independent routed recipient without correlation retains parent rejection and cannot dispatch",
  },
  {
    mode: "invalid-token",
    name: "independent routed recipient with invalid correlation cannot dispatch",
  },
  {
    mode: "no-outcome",
    name: "independent routed recipient without exact outcome evidence cannot dispatch",
  },
])("$name", async ({ mode }) => {
  const workdir = mkdtempSync(join(tmpdir(), "attention-watch-membership-"));
  const logger = createTestLogger();
  const warnings = vi.spyOn(logger, "warn");
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const parentPrompts: string[] = [];
  const manager = new AgentManager({
    registry: storage,
    logger,
    clients: createTestAgentClients({
      onStartTurn: (prompt, config) => {
        if (config.title === "Caller")
          parentPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
      },
    }),
  });
  manager.setAttentionHost({ serverId: "origin", resolveRemoteRequester: async () => "unknown" });
  const source = new AgentAttentionObjectives(undefined, "origin");
  source.admit({
    inputs: [
      { kind: "human", requestId: "human-A" },
      { kind: "human", requestId: "human-B" },
    ],
  });
  source.declare("human-A", "waiting");
  source.declare("human-B", "waiting");
  const callerId = randomUUID();
  const childId = randomUUID();
  const peer = { agentId: childId, serverId: "target" };
  const links = ["human-A", "human-B"].map(
    (objectiveId) => source.outgoing({ recipient: peer, objectiveId })?.requesterObjective,
  );
  await manager.createAgent({ provider: "claude", cwd: workdir, title: "Caller" }, callerId, {
    workspaceId: undefined,
    attentionObjectives: source.snapshot(),
  });
  const child = await manager.createAgent(
    { provider: "claude", cwd: workdir, title: "Child" },
    childId,
    {
      workspaceId: undefined,
      labels:
        mode === "parented"
          ? {
              "paseo.parent-agent-id": callerId,
              "paseo.parent-server-id": "origin",
            }
          : undefined,
    },
  );
  const final = toAgentPayload(child, { title: "Child" });
  const delivery = createTestAgentMessages({
    agentManager: manager,
    agentStorage: storage,
    logger,
  });
  const outcomes = [
    Promise.withResolvers<WaitForFinishResult>(),
    Promise.withResolvers<WaitForFinishResult>(),
  ];
  const enqueue = vi.spyOn(delivery, "enqueue");
  const reservations = vi.spyOn(manager, "reserveAttentionCallback");
  const signals: AbortSignal[] = [];
  const acknowledgements: string[] = [];
  const stops: Array<() => void> = [];

  async function stopRefusedWatches() {
    // Exact refusals remain durable retry intents. Prove refusal and absence of
    // delivery before retiring them, so teardown cannot hide an unintended callback.
    await expect
      .poll(
        () =>
          warnings.mock.calls.filter(([, message]) => message === "Retrying finish subscription")
            .length,
      )
      .toBe(2);
    for (const [detail, message] of warnings.mock.calls) {
      if (message !== "Retrying finish subscription") continue;
      const error = (detail as { err: unknown }).err;
      if (mode === "invalid-token") expect(error).toBeInstanceOf(AttentionObjectiveError);
      else
        expect(error).toMatchObject({
          message: "Exact finish outcome is unavailable or mismatched",
        });
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(acknowledgements).toEqual([]);
    expect(parentPrompts).toEqual([]);
    expect(
      (await storage.get(callerId))?.attentionObjectives?.delegations.every(
        (entry) => !entry.deliveries?.length,
      ),
    ).toBe(true);
    for (const stop of stops) stop();
  }

  /** Report fixed failure categories without leaking error payloads, paths, or endpoint details. */
  function callbackErrorKind(error: unknown): string {
    if (error instanceof AttentionObjectiveError) return "attention-objective-refused";
    if (error instanceof AgentRunCancellationError) return "run-cancellation-refused";
    if (!(error instanceof Error)) return "non-error-rejection";
    if (error.message === "Active turn changed before steering could be delivered")
      return "active-turn-changed-before-dispatch";
    if (error.message === "A foreground turn is already active")
      return "provider-foreground-already-active";
    if (error.name === "AbortError") return "aborted";
    return "unclassified-error";
  }

  try {
    for (const [index, link] of links.entries()) {
      if (!link) throw new Error("Expected exact request link");
      let first = true;
      stops.push(
        setupFinishWait({
          agentManager: manager,
          agentStorage: storage,
          agentMessages: delivery,
          originServerId: "origin",
          childServerId: "target",
          childAgentId: childId,
          callerAgentId: callerId,
          attention:
            mode === "legacy"
              ? undefined
              : {
                  continuation:
                    mode === "invalid-token" ? { ...link, token: "invalid-token" } : link,
                },
          logger,
          wait: async (signal, query) => {
            if (query?.acknowledgeOutcomeId) acknowledgements.push(query.acknowledgeOutcomeId);
            if (first) {
              first = false;
              signals.push(signal);
              return outcomes[index].promise;
            }
            return {
              status: "idle",
              final,
              error: null,
              lastMessage: null,
              attentionOutcome: null,
            };
          },
          afterPermission: async () => {},
        }),
      );
    }
    for (const index of [1, 0]) {
      const link = links[index];
      if (!link) throw new Error("Expected request link");
      outcomes[index].resolve({
        status: "idle",
        final,
        error: null,
        lastMessage: "Untrusted current message",
        attentionOutcome:
          mode === "no-outcome"
            ? null
            : {
                id: randomUUID(),
                requestId: link.requestId,
                requester: { agentId: callerId, serverId: "origin" },
                acceptedTurnId: `target-${index}`,
                kind: "finished",
                lastMessage: `EXACT_RESULT_${index}`,
                error: null,
              },
      });
    }
    if (mode === "invalid-token" || mode === "no-outcome") await stopRefusedWatches();
    await expect
      .poll(
        () =>
          signals.length === (mode === "legacy" ? 1 : 2) &&
          signals.every((signal) => signal.aborted),
      )
      .toBe(true);
    // Observe real public receipts only after both watch paths have settled, without wrapping dispatch.
    const dispatched = enqueue.mock.results.flatMap((result) => {
      if (result.type === "return") return [result.value.dispatched];
      return [];
    });
    const settlements = await Promise.allSettled(dispatched);
    const dispatches = settlements.map((result) => {
      if (result.status === "fulfilled")
        return { status: result.status, disposition: result.value };
      return { status: result.status, rejection: callbackErrorKind(result.reason) };
    });
    const watchFailures = warnings.mock.calls.flatMap(([detail, message]) => {
      if (message !== "Retrying finish subscription") return [];
      const context: unknown = detail;
      if (typeof context === "object" && context !== null && "err" in context)
        return [callbackErrorKind(context.err)];
      return ["unclassified-watch-warning"];
    });
    const diagnostic = `Exact routed callback evidence: ${JSON.stringify({ watchFailures, dispatches })}`;
    if (mode === "parented" || mode === "independent") {
      expect(reservations, diagnostic).toHaveBeenCalledTimes(2);
      expect(enqueue, diagnostic).toHaveBeenCalledTimes(2);
      expect(acknowledgements, diagnostic).toHaveLength(2);
      const stored = (await storage.get(callerId))?.attentionObjectives;
      expect(
        stored?.delegations.map((entry) => entry.deliveries?.map((item) => item.status)),
        diagnostic,
      ).toEqual([["consumed"], ["consumed"]]);
      expect(parentPrompts.join("\n"), diagnostic).toContain("EXACT_RESULT_0");
      expect(parentPrompts.join("\n"), diagnostic).toContain("EXACT_RESULT_1");
      expect(parentPrompts.join("\n"), diagnostic).not.toContain("Untrusted current message");
    } else {
      expect(parentPrompts).toEqual([]);
      expect(enqueue).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([]);
      expect(
        (await storage.get(callerId))?.attentionObjectives?.delegations.every(
          (entry) => !entry.deliveries?.length,
        ),
      ).toBe(true);
    }
  } finally {
    warnings.mockRestore();
    for (const stop of stops) stop();
    await delivery.close();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flush();
    rmSync(workdir, { recursive: true, force: true });
  }
});

it.each([
  {
    mode: "failed-write",
    name: "thrown callback reservation snapshot prevents enqueue and acknowledgement and permits retry",
  },
  {
    mode: "restored",
    name: "fresh manager recovers an exact unconsumed callback reservation and delivers once",
  },
  {
    mode: "competing",
    name: "competing live callback watchers cannot both dispatch the same outcome",
  },
  {
    mode: "await-retirement",
    name: "callback watcher retired during the supersession await cannot enqueue or acknowledge and exact retry succeeds",
  },
])("$name", async ({ mode }) => {
  const workdir = mkdtempSync(join(tmpdir(), "attention-callback-recovery-"));
  const logger = createTestLogger();
  const warnings = vi.spyOn(logger, "warn");
  class ReservationStorage extends AgentStorage {
    failNextReservationWrite = false;

    override async applySnapshot(
      agent: ManagedAgent,
      options?: Parameters<AgentStorage["applySnapshot"]>[1],
    ): Promise<void> {
      const hasReservation = agent.attentionObjectives
        ?.snapshot()
        .delegations.some((entry) =>
          entry.deliveries?.some((delivery) => delivery.status === "reserved"),
        );
      if (this.failNextReservationWrite && hasReservation) {
        this.failNextReservationWrite = false;
        // A failed persistence call may already have written the reservation to disk.
        await super.applySnapshot(agent, options);
        throw new Error("Reservation snapshot failed");
      }
      await super.applySnapshot(agent, options);
    }
  }
  let storage = new ReservationStorage(join(workdir, "agents"), logger);
  const prompts: string[] = [];
  const clients = createTestAgentClients({
    onStartTurn: (prompt) => {
      // This fixture prompts only the caller. Its display title is absent from provider resume overrides.
      prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    },
  });
  let manager = new AgentManager({ registry: storage, logger, clients });
  manager.setAttentionHost({ serverId: "origin", resolveRemoteRequester: async () => "unknown" });
  const managers = [manager];
  const callerId = randomUUID();
  const childId = randomUUID();
  const peer = { agentId: childId, serverId: "target" };
  const source = new AgentAttentionObjectives(undefined, "origin");
  source.admit({ inputs: [{ kind: "human", requestId: "human-job" }] });
  source.declare("human-job", "waiting");
  const link = source.outgoing({ recipient: peer })?.requesterObjective;
  if (!link) throw new Error("Expected exact request link");
  await manager.createAgent({ provider: "claude", cwd: workdir, title: "Caller" }, callerId, {
    workspaceId: undefined,
    attentionObjectives: source.snapshot(),
  });
  const child = await manager.createAgent(
    { provider: "claude", cwd: workdir, title: "Child" },
    childId,
    {
      workspaceId: undefined,
      labels: { "paseo.parent-agent-id": callerId, "paseo.parent-server-id": "origin" },
    },
  );
  await manager.flush();
  const outcome = {
    id: randomUUID(),
    requestId: link.requestId,
    requester: { agentId: callerId, serverId: "origin" },
    acceptedTurnId: "target-turn",
    kind: "finished" as const,
    lastMessage: "EXACT_RECOVERED_RESULT",
    error: null,
  };
  const claim = { agentId: callerId, peer, link, outcome, deliveryId: outcome.id };
  const result: WaitForFinishResult = {
    status: "idle",
    final: toAgentPayload(child, { title: "Child" }),
    error: null,
    lastMessage: "Unrelated current content",
    attentionOutcome: outcome,
  };
  const ackIds: string[] = [];
  const acknowledged = Promise.withResolvers<void>();
  const reservationEntered = Promise.withResolvers<void>();
  const returnReservation = Promise.withResolvers<void>();
  const retryReservation = Promise.withResolvers<void>();
  const retiredDuringAwait = Promise.withResolvers<void>();
  const stops: Array<() => void> = [];
  const deliveries: Array<ReturnType<typeof createTestAgentMessages>> = [];

  /** Restore the actual persisted source with its full identity and reservation assertions. */
  async function restoreReservedCaller(): Promise<void> {
    // Persist before enqueueing, then discard the manager and all of its live ownership.
    expect((await manager.reserveAttentionCallback(claim)).status).toBe("reserved");
    expect((await storage.get(callerId))?.attentionObjectives?.delegations[0].deliveries).toEqual([
      { outcomeId: outcome.id, deliveryId: outcome.id, status: "reserved" },
    ]);
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flush();
    storage = new ReservationStorage(join(workdir, "agents"), logger);
    manager = new AgentManager({ registry: storage, logger, clients });
    managers.push(manager);
    manager.setAttentionHost({
      serverId: "origin",
      resolveRemoteRequester: async () => "unknown",
    });
    await ensureAgentLoaded(callerId, { agentManager: manager, agentStorage: storage, logger });
    expect(manager.listAgents().map((agent) => agent.id)).toEqual([callerId]);
    expect(() =>
      manager.getAgent(callerId)?.attentionObjectives?.assertAdmissions([
        {
          kind: "agent",
          requestId: outcome.id,
          requester: peer,
          attention: {
            continuation: link,
            delivery: { outcomeId: outcome.id, deliveryId: outcome.id },
          },
        },
      ]),
    ).toThrow("Objective");
    await expect(
      manager.reserveAttentionCallback({ ...claim, deliveryId: "other-message" }),
    ).rejects.toThrow("Objective");
  }

  const retireWatcherDuringAwait = () => {
    stops[0]();
    retiredDuringAwait.resolve();
  };
  const queueWatcherRetirement = () => queueMicrotask(retireWatcherDuringAwait);
  try {
    if (mode === "restored") await restoreReservedCaller();
    const delivery = createTestAgentMessages({
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    deliveries.push(delivery);
    const enqueue = vi.spyOn(delivery, "enqueue");
    const release = vi.spyOn(manager, "releaseAttentionCallback");
    const reserve = manager.reserveAttentionCallback.bind(manager);
    if (mode === "failed-write") {
      storage.failNextReservationWrite = true;
      let attempts = 0;
      vi.spyOn(manager, "reserveAttentionCallback").mockImplementation(async (input) => {
        if (++attempts > 1) await retryReservation.promise;
        return reserve(input);
      });
    }
    if (mode === "competing") {
      vi.spyOn(manager, "reserveAttentionCallback").mockImplementationOnce(async (input) => {
        const reservation = await reserve(input);
        reservationEntered.resolve();
        await returnReservation.promise;
        return reservation;
      });
    }
    if (mode === "await-retirement") {
      vi.spyOn(manager, "reserveAttentionCallback").mockImplementationOnce(async (input) => {
        const reservation = await reserve(input);
        // The first microtask queues retirement behind the watcher's reservation continuation.
        // That continuation starts awaiting false, then retirement runs before the await resumes.
        queueMicrotask(queueWatcherRetirement);
        return reservation;
      });
    }
    const watch = () => {
      stops.push(
        setupFinishWait({
          agentManager: manager,
          agentStorage: storage,
          agentMessages: delivery,
          originServerId: "origin",
          childServerId: "target",
          childAgentId: childId,
          callerAgentId: callerId,
          attention: { continuation: link },
          logger,
          wait: async (_signal, query) => {
            if (query?.acknowledgeOutcomeId) {
              ackIds.push(query.acknowledgeOutcomeId);
              acknowledged.resolve();
              return { ...result, attentionOutcome: null };
            }
            return result;
          },
          afterPermission: async () => {},
        }),
      );
    };
    watch();
    if (mode === "competing") {
      await reservationEntered.promise;
      // A replacement watcher reaches the same durable reservation while the first still owns it.
      watch();
    }
    if (mode === "await-retirement") {
      await retiredDuringAwait.promise;
      await expect.poll(() => release.mock.calls.length).toBe(1);
      await release.mock.results[0].value;
      expect(enqueue).not.toHaveBeenCalled();
      expect(ackIds).toEqual([]);
      expect(prompts).toEqual([]);
      watch();
    } else if (mode !== "restored") {
      await expect.poll(() => warnings.mock.calls.length).toBe(1);
      expect(enqueue).not.toHaveBeenCalled();
      expect(ackIds).toEqual([]);
      if (mode === "failed-write") {
        // Rollback belongs to reserveAttentionCallback, rather than the caller's enqueue catch.
        expect(release).not.toHaveBeenCalled();
        expect(
          manager.getAgent(callerId)?.attentionObjectives?.snapshot().delegations[0].deliveries,
        ).toEqual([]);
        expect(
          (await storage.get(callerId))?.attentionObjectives?.delegations[0].deliveries,
        ).toEqual([{ outcomeId: outcome.id, deliveryId: outcome.id, status: "reserved" }]);
      } else {
        returnReservation.resolve();
        await expect.poll(() => release.mock.calls.length).toBe(1);
        // Await release completion before retrying the abandoned live owner's outcome.
        await release.mock.results[0].value;
      }
      watch();
      retryReservation.resolve();
    }
    await acknowledged.promise;
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: callerId,
        messageId: outcome.id,
      }),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("EXACT_RECOVERED_RESULT");
    expect(prompts[0]).not.toContain("Unrelated current content");
    expect(ackIds).toEqual([outcome.id]);
    expect((await storage.get(callerId))?.attentionObjectives?.delegations[0].deliveries).toEqual([
      { outcomeId: outcome.id, deliveryId: outcome.id, status: "consumed" },
    ]);
    // Reobservation acknowledges retained evidence without acquiring another dispatch owner.
    watch();
    await expect.poll(() => ackIds.length).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
  } finally {
    returnReservation.resolve();
    retryReservation.resolve();
    for (const stop of stops) stop();
    for (const delivery of deliveries) await delivery.close();
    for (const current of managers.toReversed()) {
      await Promise.all(current.listAgents().map((agent) => current.closeAgent(agent.id)));
      await current.flush();
    }
    warnings.mockRestore();
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("schedule prompts remain visible as completed tool calls on replay", () => {
  const text = formatSystemNotificationPrompt("Heartbeat: check progress");
  expect(projectAgentMessages({ type: "user_message", messageId: "fire-1", text })).toEqual([
    expect.objectContaining({
      type: "tool_call",
      status: "completed",
      detail: { type: "plain_text", text: "Heartbeat: check progress", icon: "sparkles" },
    }),
  ]);
});

test("schedule trigger identity survives the provider assigning a message ID", () => {
  const text = formatSystemNotificationPrompt("Schedule fired (id=heartbeat, run=run-1).");
  expect(projectAgentMessages({ type: "user_message", text })).toEqual(
    projectAgentMessages({ type: "user_message", text, messageId: "provider-message" }),
  );
});

// Existing exact-callback scenarios run through the durable service and real source ledger.
interface FinishWaitFixture {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentMessages: AgentMessageDelivery;
  originServerId?: string;
  childServerId?: string;
  callerAgentId: string;
  childAgentId: string;
  attention?: AgentMessageAttention;
  logger: Logger;
  wait(signal: AbortSignal, query?: AgentAttentionRequestQuery): Promise<WaitForFinishResult>;
  afterPermission(requestId: string, signal: AbortSignal): Promise<void>;
}
const finishFixtures = new WeakMap<
  AgentManager,
  {
    service: ReturnType<typeof createFinishSubscriptions>;
    waits: Map<string, FinishWaitFixture>;
  }
>();
function setupFinishWait(params: FinishWaitFixture): () => void {
  let fixture = finishFixtures.get(params.agentManager);
  const identity = (record: Pick<FinishSubscription, "childAgentId" | "attention">) =>
    JSON.stringify([record.childAgentId, record.attention?.link.requestId]);
  if (!fixture) {
    const waits = new Map<string, FinishWaitFixture>();
    const records = new Map<string, FinishSubscription>();
    const observation = createFinishObservation({
      agentManager: params.agentManager,
      agentStorage: params.agentStorage,
      messages: () => params.agentMessages,
      serverId: params.originServerId ?? "self",
      logger: params.logger,
      waitForResume: async () => {},
      hosts: () => {
        throw new Error("Fixture uses the injected exact remote wait");
      },
    });
    const service = createFinishSubscriptions({
      ...observation,
      store: {
        list: async () => [...records.values()],
        put: async (record) => {
          records.set(record.id, record);
        },
        remove: async (id) => {
          records.delete(id);
        },
      },
      serverId: params.originServerId ?? "self",
      logger: params.logger,
      retryDelayMs: 10,
      messages: () => params.agentMessages,
      callerIsActive: async (id) => !(await params.agentStorage.get(id))?.archivedAt,
      open: async (record, signal) => ({
        next: () => waits.get(identity(record))!.wait(signal, record.attention),
        close: async () => {},
      }),
      acknowledgeExact: async (record, outcomeId, signal) => {
        await waits
          .get(identity(record))!
          .wait(signal, { ...record.attention!, acknowledgeOutcomeId: outcomeId });
      },
    });
    fixture = { service, waits };
    finishFixtures.set(params.agentManager, fixture);
    void service.start();
  }
  const attention = params.attention?.continuation
    ? {
        link: params.attention.continuation,
        requester: params.agentManager.attentionRequester(params.callerAgentId),
      }
    : undefined;
  fixture.waits.set(identity({ childAgentId: params.childAgentId, attention }), params);
  const registration = fixture.service.register({
    callerAgentId: params.callerAgentId,
    childAgentId: params.childAgentId,
    serverId: params.childServerId,
    attention,
    requireParentOwnership: true,
  });
  let retired = false;
  void registration.then((ready) => {
    if (retired) return ready.reject();
    return undefined;
  });
  return () => {
    retired = true;
    void registration.then((ready) => ready.reject());
  };
}
