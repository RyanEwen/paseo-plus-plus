import {
  createFinishSubscriptions,
  createFinishObservation,
  type FinishSubscription,
} from "./index.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import type {
  AgentAttentionLink,
  AgentMessageAttention,
  AgentAttentionRequestQuery,
} from "@getpaseo/protocol/agent-attention";
import type { Logger } from "pino";
import { AgentAttentionObjectives } from "../attention/objectives.js";
import { AttentionObjectiveError } from "../attention/errors.js";
import { toAgentPayload } from "../agent-projections.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import { createTestAgentMessages } from "../../test-utils/agent-messages.js";
import { expect, test, vi, type MockInstance } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { ensureAgentLoaded } from "../agent-loading.js";
import { AgentStorage } from "../agent-storage.js";
import type { ManagedAgent } from "../agent-manager.js";

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
  /** Receives every retried delivery failure of the shared service (first fixture wins). */
  onRetry?: (retry: FinishRetry) => void;
  /** Awaited between an exact reservation and its enqueue (first fixture wins). */
  beforeCallbackEnqueue?: (input: { outcomeId: string }) => Promise<void>;
  /** Replaces the service retry pause (first fixture wins). */
  retryDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
}
interface FinishRetry {
  subscription: FinishSubscription;
  error: unknown;
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
      beforeCallbackEnqueue: async (gate) => {
        await params.beforeCallbackEnqueue?.(gate);
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
      onRetry: (retry) => params.onRetry?.(retry),
      retryDelay: params.retryDelay,
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

/**
 * A caller with two waiting human objectives, each delegated to the same routed child. Tests
 * choose the correlation each watch claims and the outcome each child result carries.
 */
/**
 * One line per queued callback: its event, the exact outcome it carries, which child result its
 * prompt names, and whether its dispatch reached the caller. A failed dispatch was never
 * delivered; the watch releases its reservation and queues the same outcome again.
 */
async function describeQueuedCallbacks(
  enqueue: MockInstance<AgentMessageDelivery["enqueue"]>,
): Promise<Array<{ line: string; outcomeId: string; delivered: boolean }>> {
  const dispatches = await Promise.allSettled(
    enqueue.mock.results.map((result) =>
      result.type === "return" ? result.value.dispatched : Promise.reject(result.value),
    ),
  );
  return enqueue.mock.calls.map(([message], index) => {
    const prompt =
      typeof message.prompt === "string" ? message.prompt : JSON.stringify(message.prompt);
    const result = prompt.match(/EXACT_RESULT_\d|Untrusted current message/)?.[0] ?? "no result";
    const outcomeId = message.source.attention?.delivery?.outcomeId ?? "none";
    const delivered = dispatches[index]?.status === "fulfilled";
    const status = delivered ? "delivered" : "failed";
    return {
      line: `${message.source.event} outcome=${outcomeId} result=${result} ${status}`,
      outcomeId,
      delivered,
    };
  });
}

async function createRoutedRecipientScenario(input: { parented: boolean }) {
  const workdir = mkdtempSync(join(tmpdir(), "attention-watch-membership-"));
  const logger = createTestLogger();
  const retries: FinishRetry[] = [];
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const parentPrompts: string[] = [];
  const manager = new AgentManager({
    registry: storage,
    logger,
    clients: createTestAgentClients({
      onStartTurn: (prompt, config) => {
        if (config.title === "Caller") {
          parentPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
        }
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
  const links = ["human-A", "human-B"].map((objectiveId) => {
    const link = source.outgoing({ recipient: peer, objectiveId })?.requesterObjective;
    if (!link) {
      throw new Error("Expected exact request link");
    }
    return link;
  });
  await manager.createAgent({ provider: "claude", cwd: workdir, title: "Caller" }, callerId, {
    workspaceId: undefined,
    attentionObjectives: source.snapshot(),
  });
  const child = await manager.createAgent(
    { provider: "claude", cwd: workdir, title: "Child" },
    childId,
    {
      workspaceId: undefined,
      labels: input.parented
        ? { "paseo.parent-agent-id": callerId, "paseo.parent-server-id": "origin" }
        : undefined,
    },
  );
  const final = toAgentPayload(child, { title: "Child" });
  const delivery = createTestAgentMessages({
    agentManager: manager,
    agentStorage: storage,
    logger,
  });
  const outcomes = links.map(() => Promise.withResolvers<WaitForFinishResult>());
  const enqueue = vi.spyOn(delivery, "enqueue");
  const signals: AbortSignal[] = [];
  const acknowledgements: string[] = [];
  const stops: Array<() => void> = [];

  /** The idle result a watch reads after its first, test-controlled observation. */
  const settledResult: WaitForFinishResult = {
    status: "idle",
    final,
    error: null,
    lastMessage: null,
    attentionOutcome: null,
  };

  /** Watch each delegated request, claiming the correlation `attentionFor` returns. */
  function watchRequests(
    attentionFor: (link: AgentAttentionLink) => AgentMessageAttention | undefined,
  ) {
    for (const [index, link] of links.entries()) {
      let first = true;
      const wait = async (signal: AbortSignal, query?: AgentAttentionRequestQuery) => {
        if (query?.acknowledgeOutcomeId) {
          acknowledgements.push(query.acknowledgeOutcomeId);
        }
        if (!first) {
          return settledResult;
        }
        first = false;
        signals.push(signal);
        return outcomes[index]!.promise;
      };
      stops.push(
        setupFinishWait({
          agentManager: manager,
          agentStorage: storage,
          agentMessages: delivery,
          originServerId: "origin",
          childServerId: "target",
          childAgentId: childId,
          callerAgentId: callerId,
          attention: attentionFor(link),
          logger,
          wait,
          onRetry: (retry) => retries.push(retry),
          afterPermission: async () => {},
        }),
      );
    }
  }

  /** Resolve both child results, newest request first, with or without exact outcome evidence. */
  function resolveResults(withOutcome: boolean) {
    for (const index of [1, 0]) {
      const link = links[index]!;
      outcomes[index]!.resolve({
        status: "idle",
        final,
        error: null,
        lastMessage: "Untrusted current message",
        attentionOutcome: withOutcome
          ? {
              id: randomUUID(),
              requestId: link.requestId,
              requester: { agentId: callerId, serverId: "origin" },
              acceptedTurnId: `target-${index}`,
              kind: "finished",
              lastMessage: `EXACT_RESULT_${index}`,
              error: null,
            }
          : null,
      });
    }
  }

  /**
   * Wait until `count` watches ended, then for the dispatch receipts they produced. A callback
   * reservation can retry a few times before its objective is admitted for the caller's turn,
   * which takes well over the default one-second poll on a loaded CI runner.
   */
  async function settleWatches(count: number) {
    await expect
      .poll(() => signals.length === count && signals.every((signal) => signal.aborted), {
        timeout: 15_000,
      })
      .toBe(true);
    const dispatched = enqueue.mock.results.flatMap((result) =>
      result.type === "return" ? [result.value.dispatched] : [],
    );
    await Promise.allSettled(dispatched);
  }

  async function storedDeliveries() {
    return (await storage.get(callerId))?.attentionObjectives?.delegations.map(
      (entry) => entry.deliveries ?? [],
    );
  }

  async function cleanup() {
    for (const stop of stops) {
      stop();
    }
    await delivery.close();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flush();
    rmSync(workdir, { recursive: true, force: true });
  }

  return {
    retries,
    parentPrompts,
    enqueue,
    acknowledgements,
    stops,
    watchRequests,
    resolveResults,
    settleWatches,
    storedDeliveries,
    cleanup,
  };
}

it.each([
  {
    parented: true,
    name: "keeps two exact routed request watches so later work cannot discard an earlier result",
  },
  {
    parented: false,
    name: "independent routed recipient returns exact outcomes despite parent mismatch",
  },
])("$name", async ({ parented }) => {
  const scenario = await createRoutedRecipientScenario({ parented });
  try {
    scenario.watchRequests((link) => ({ continuation: link }));
    scenario.resolveResults(true);
    await scenario.settleWatches(2);

    // A dispatch can fail when the caller's turn changes under it; the watch then queues the same
    // outcome again. Count deliveries, not queue attempts, and require each outcome exactly once.
    const queued = await describeQueuedCallbacks(scenario.enqueue);
    const delivered = queued.filter((entry) => entry.delivered).map((entry) => entry.outcomeId);
    const report = JSON.stringify({
      queued: queued.map((entry) => entry.line),
      retries: scenario.retries.map((retry) => String(retry.error)),
    });
    expect(delivered, report).toHaveLength(2);
    expect(new Set(delivered).size, report).toBe(2);
    expect(scenario.acknowledgements).toHaveLength(2);
    expect(
      (await scenario.storedDeliveries())?.map((entries) => entries.map((item) => item.status)),
    ).toEqual([["consumed"], ["consumed"]]);
    const prompts = scenario.parentPrompts.join("\n");
    expect(prompts).toContain("EXACT_RESULT_0");
    expect(prompts).toContain("EXACT_RESULT_1");
    expect(prompts).not.toContain("Untrusted current message");
  } finally {
    await scenario.cleanup();
  }
});

test("a callback whose dispatch fails is queued again and delivered once", async () => {
  const scenario = await createRoutedRecipientScenario({ parented: false });
  try {
    // The first callback's dispatch fails as it does when the caller's active turn changes.
    scenario.enqueue.mockImplementationOnce((message) => {
      const dispatched = Promise.reject(
        new Error("Active turn changed before steering could be delivered"),
      );
      void dispatched.catch(() => undefined);
      return { status: "queued", messageId: message.messageId ?? randomUUID(), dispatched };
    });
    scenario.watchRequests((link) => ({ continuation: link }));
    scenario.resolveResults(true);
    await scenario.settleWatches(2);

    const queued = await describeQueuedCallbacks(scenario.enqueue);
    const delivered = queued.filter((entry) => entry.delivered).map((entry) => entry.outcomeId);
    expect(queued.filter((entry) => !entry.delivered)).toHaveLength(1);
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered).size).toBe(2);
    expect(scenario.retries.map((retry) => String(retry.error))).toEqual([
      "Error: Active turn changed before steering could be delivered",
    ]);
    expect(
      (await scenario.storedDeliveries())?.map((entries) => entries.map((item) => item.status)),
    ).toEqual([["consumed"], ["consumed"]]);
  } finally {
    await scenario.cleanup();
  }
});

it.each([
  {
    name: "independent routed recipient with invalid correlation cannot dispatch",
    attentionFor: (link: AgentAttentionLink) => ({
      continuation: { ...link, token: "invalid-token" },
    }),
    withOutcome: true,
    retryError: expect.any(AttentionObjectiveError),
  },
  {
    name: "independent routed recipient without exact outcome evidence cannot dispatch",
    attentionFor: (link: AgentAttentionLink) => ({ continuation: link }),
    withOutcome: false,
    retryError: expect.objectContaining({
      message: "Exact finish outcome is unavailable or mismatched",
    }),
  },
])("$name", async ({ attentionFor, withOutcome, retryError }) => {
  const scenario = await createRoutedRecipientScenario({ parented: false });
  try {
    scenario.watchRequests(attentionFor);
    scenario.resolveResults(withOutcome);
    // Exact refusals remain durable retry intents. Prove refusal and absence of
    // delivery before retiring them, so teardown cannot hide an unintended callback.
    await expect
      .poll(() => new Set(scenario.retries.map((retry) => retry.subscription.id)).size)
      .toBe(2);
    expect(scenario.retries.map((retry) => retry.error)).toEqual(
      scenario.retries.map(() => retryError),
    );
    expect(scenario.enqueue).not.toHaveBeenCalled();
    expect(scenario.acknowledgements).toEqual([]);
    expect(scenario.parentPrompts).toEqual([]);
    expect(await scenario.storedDeliveries()).toEqual([[], []]);
    for (const stop of scenario.stops) {
      stop();
    }
    await scenario.settleWatches(2);

    expect(scenario.enqueue).not.toHaveBeenCalled();
    expect(scenario.parentPrompts).toEqual([]);
  } finally {
    await scenario.cleanup();
  }
});

test("independent routed recipient without correlation retains parent rejection and cannot dispatch", async () => {
  const scenario = await createRoutedRecipientScenario({ parented: false });
  try {
    scenario.watchRequests(() => undefined);
    scenario.resolveResults(true);
    await scenario.settleWatches(1);

    expect(scenario.parentPrompts).toEqual([]);
    expect(scenario.enqueue).not.toHaveBeenCalled();
    expect(scenario.acknowledgements).toEqual([]);
    expect(await scenario.storedDeliveries()).toEqual([[], []]);
  } finally {
    await scenario.cleanup();
  }
});

/** Agent storage whose next snapshot carrying a reserved delivery writes and then throws. */
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

type RecoveryHooks = Pick<FinishWaitFixture, "beforeCallbackEnqueue" | "retryDelay">;

/** Run `hold` for the first reserved outcome only; later reservations pass straight through. */
function holdFirstReservation(hold: () => Promise<void>) {
  let first = true;
  return async () => {
    if (!first) {
      return;
    }
    first = false;
    await hold();
  };
}

/**
 * A caller with one waiting human objective delegated to a parented child whose exact finished
 * outcome is ready. Tests watch it through the gate harness and assert one exact delivery.
 */
async function createCallbackRecoveryScenario(options: { objectiveFinal?: boolean } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "attention-callback-recovery-"));
  const logger = createTestLogger();
  const retries: FinishRetry[] = [];
  const prompts: string[] = [];
  const clients = createTestAgentClients({
    onStartTurn: (prompt) => {
      // This fixture prompts only the caller. Its display title is absent from provider resume overrides.
      prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    },
  });
  const managers: AgentManager[] = [];
  /** Start a manager over `storage`, as a daemon start or restart would. */
  function startManagerOver(storage: ReservationStorage): AgentManager {
    const started = new AgentManager({ registry: storage, logger, clients });
    started.setAttentionHost({ serverId: "origin", resolveRemoteRequester: async () => "unknown" });
    managers.push(started);
    return started;
  }
  const initialStorage = new ReservationStorage(join(workdir, "agents"), logger);
  const state = { storage: initialStorage, manager: startManagerOver(initialStorage) };
  const manager = state.manager;
  const callerId = randomUUID();
  const childId = randomUUID();
  const peer = { agentId: childId, serverId: "target" };
  const source = new AgentAttentionObjectives(undefined, "origin");
  source.admit({ inputs: [{ kind: "human", requestId: "human-job" }] });
  source.declare("human-job", "waiting");
  const link = source.outgoing({ recipient: peer })?.requesterObjective;
  if (!link) {
    throw new Error("Expected exact request link");
  }
  if (options.objectiveFinal) {
    source.declare("human-job", "final");
    source.finish();
  }
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
  const stops: Array<() => void> = [];
  const deliveries: Array<ReturnType<typeof createTestAgentMessages>> = [];

  /** Restore the actual persisted source with its full identity and reservation assertions. */
  async function restoreReservedCaller(): Promise<void> {
    // Persist before enqueueing, then discard the manager and all of its live ownership.
    const previous = state.manager;
    expect((await previous.reserveAttentionCallback(claim)).status).toBe("reserved");
    expect(
      (await state.storage.get(callerId))?.attentionObjectives?.delegations[0].deliveries,
    ).toEqual([{ outcomeId: outcome.id, deliveryId: outcome.id, status: "reserved" }]);
    await Promise.all(previous.listAgents().map((agent) => previous.closeAgent(agent.id)));
    await previous.flush();
    state.storage = new ReservationStorage(join(workdir, "agents"), logger);
    const restored = startManagerOver(state.storage);
    state.manager = restored;
    await ensureAgentLoaded(callerId, {
      agentManager: restored,
      agentStorage: state.storage,
      logger,
    });
    expect(restored.listAgents().map((agent) => agent.id)).toEqual([callerId]);
    expect(() =>
      restored.getAgent(callerId)?.attentionObjectives?.assertAdmissions([
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
    ).toThrow(AttentionObjectiveError);
    await expect(
      restored.reserveAttentionCallback({ ...claim, deliveryId: "other-message" }),
    ).rejects.toThrow(AttentionObjectiveError);
  }

  /** Message delivery for the current manager, with enqueue and release observed. */
  function startDelivery() {
    const delivery = createTestAgentMessages({
      agentManager: state.manager,
      agentStorage: state.storage,
      logger,
    });
    deliveries.push(delivery);
    return {
      delivery,
      enqueue: vi.spyOn(delivery, "enqueue"),
      release: vi.spyOn(state.manager, "releaseAttentionCallback"),
    };
  }

  /** Watch the child's exact outcome; an acknowledgement query records its outcome id. */
  async function waitForChild(_signal: AbortSignal, query?: AgentAttentionRequestQuery) {
    if (query?.acknowledgeOutcomeId) {
      ackIds.push(query.acknowledgeOutcomeId);
      acknowledged.resolve();
      return { ...result, attentionOutcome: null };
    }
    return result;
  }

  function watch(delivery: AgentMessageDelivery, hooks: RecoveryHooks = {}) {
    stops.push(
      setupFinishWait({
        agentManager: state.manager,
        agentStorage: state.storage,
        agentMessages: delivery,
        originServerId: "origin",
        childServerId: "target",
        childAgentId: childId,
        callerAgentId: callerId,
        attention: { continuation: link },
        logger,
        wait: waitForChild,
        onRetry: (retry) => retries.push(retry),
        ...hooks,
        afterPermission: async () => {},
      }),
    );
  }

  /** The exact outcome reached the caller once, was consumed, and reobservation only acknowledges. */
  async function expectDeliveredOnce(input: {
    delivery: AgentMessageDelivery;
    enqueue: ReturnType<typeof startDelivery>["enqueue"];
    hooks?: RecoveryHooks;
  }) {
    await acknowledged.promise;
    expect(input.enqueue).toHaveBeenCalledTimes(1);
    expect(input.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: callerId, messageId: outcome.id }),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("EXACT_RECOVERED_RESULT");
    expect(prompts[0]).not.toContain("Unrelated current content");
    expect(ackIds).toEqual([outcome.id]);
    expect(
      (await state.storage.get(callerId))?.attentionObjectives?.delegations[0].deliveries,
    ).toEqual([{ outcomeId: outcome.id, deliveryId: outcome.id, status: "consumed" }]);
    // Reobservation acknowledges retained evidence without acquiring another dispatch owner.
    watch(input.delivery, input.hooks);
    await expect.poll(() => ackIds.length).toBe(2);
    expect(input.enqueue).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
  }

  async function cleanup() {
    for (const stop of stops) {
      stop();
    }
    for (const delivery of deliveries) {
      await delivery.close();
    }
    for (const current of managers.toReversed()) {
      await Promise.all(current.listAgents().map((agent) => current.closeAgent(agent.id)));
      await current.flush();
    }
    rmSync(workdir, { recursive: true, force: true });
  }

  return {
    state,
    callerId,
    outcome,
    ackIds,
    prompts,
    retries,
    stops,
    restoreReservedCaller,
    startDelivery,
    watch,
    expectDeliveredOnce,
    cleanup,
  };
}

test("thrown callback reservation snapshot prevents enqueue and acknowledgement and permits retry", async () => {
  const scenario = await createCallbackRecoveryScenario();
  const retryReservation = Promise.withResolvers<void>();
  try {
    const { delivery, enqueue, release } = scenario.startDelivery();
    scenario.state.storage.failNextReservationWrite = true;
    // Hold the retry after the failed reservation write until the refusal is asserted.
    const hooks: RecoveryHooks = {
      retryDelay: async () => {
        await retryReservation.promise;
      },
    };
    scenario.watch(delivery, hooks);
    await expect.poll(() => scenario.retries.length > 0).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(scenario.ackIds).toEqual([]);
    // Rollback belongs to reserveAttentionCallback, rather than the caller's enqueue catch.
    expect(release).not.toHaveBeenCalled();
    expect(
      scenario.state.manager.getAgent(scenario.callerId)?.attentionObjectives?.snapshot()
        .delegations[0].deliveries,
    ).toEqual([]);
    expect(
      (await scenario.state.storage.get(scenario.callerId))?.attentionObjectives?.delegations[0]
        .deliveries,
    ).toEqual([
      { outcomeId: scenario.outcome.id, deliveryId: scenario.outcome.id, status: "reserved" },
    ]);
    scenario.watch(delivery, hooks);
    retryReservation.resolve();

    await scenario.expectDeliveredOnce({ delivery, enqueue, hooks });
  } finally {
    retryReservation.resolve();
    await scenario.cleanup();
  }
});

test("fresh manager recovers an exact unconsumed callback reservation and delivers once", async () => {
  const scenario = await createCallbackRecoveryScenario();
  try {
    await scenario.restoreReservedCaller();
    const { delivery, enqueue } = scenario.startDelivery();
    scenario.watch(delivery);

    await scenario.expectDeliveredOnce({ delivery, enqueue });
  } finally {
    await scenario.cleanup();
  }
});

test("a child's completion still reaches the caller after the objective is marked final", async () => {
  const scenario = await createCallbackRecoveryScenario({ objectiveFinal: true });
  try {
    const { delivery, enqueue } = scenario.startDelivery();
    scenario.watch(delivery);

    await scenario.expectDeliveredOnce({ delivery, enqueue });
    expect(scenario.state.manager.getAttentionObjectives(scenario.callerId).objectives).toEqual([]);
  } finally {
    await scenario.cleanup();
  }
});

test("competing live callback watchers cannot both dispatch the same outcome", async () => {
  const scenario = await createCallbackRecoveryScenario();
  const reservationEntered = Promise.withResolvers<void>();
  const returnReservation = Promise.withResolvers<void>();
  try {
    const { delivery, enqueue, release } = scenario.startDelivery();
    // The first watcher owns the reservation, held before enqueue, while a second arrives.
    const hooks: RecoveryHooks = {
      beforeCallbackEnqueue: holdFirstReservation(async () => {
        reservationEntered.resolve();
        await returnReservation.promise;
      }),
    };
    scenario.watch(delivery, hooks);
    await reservationEntered.promise;
    // A replacement watcher reaches the same durable reservation while the first still owns it.
    scenario.watch(delivery, hooks);
    await expect.poll(() => scenario.retries.length > 0).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(scenario.ackIds).toEqual([]);
    returnReservation.resolve();
    await expect.poll(() => release.mock.calls.length).toBe(1);
    // Await release completion before retrying the abandoned live owner's outcome.
    await release.mock.results[0].value;
    scenario.watch(delivery, hooks);

    await scenario.expectDeliveredOnce({ delivery, enqueue, hooks });
  } finally {
    returnReservation.resolve();
    await scenario.cleanup();
  }
});

test("callback watcher retired during the supersession await cannot enqueue or acknowledge and exact retry succeeds", async () => {
  const scenario = await createCallbackRecoveryScenario();
  const retired = Promise.withResolvers<void>();
  try {
    const { delivery, enqueue, release } = scenario.startDelivery();
    // Retire the first watcher after it reserved and before it could enqueue.
    const hooks: RecoveryHooks = {
      beforeCallbackEnqueue: holdFirstReservation(async () => {
        scenario.stops[0]?.();
        retired.resolve();
      }),
    };
    scenario.watch(delivery, hooks);
    await retired.promise;
    await expect.poll(() => release.mock.calls.length).toBe(1);
    await release.mock.results[0].value;
    expect(enqueue).not.toHaveBeenCalled();
    expect(scenario.ackIds).toEqual([]);
    expect(scenario.prompts).toEqual([]);
    scenario.watch(delivery, hooks);

    await scenario.expectDeliveredOnce({ delivery, enqueue, hooks });
  } finally {
    await scenario.cleanup();
  }
});
