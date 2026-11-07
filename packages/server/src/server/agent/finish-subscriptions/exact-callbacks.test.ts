import {
  createFinishSubscriptions,
  createFinishObservation,
  type FinishSubscription,
} from "./index.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import type {
  AgentMessageAttention,
  AgentAttentionRequestQuery,
} from "@getpaseo/protocol/agent-attention";
import type { Logger } from "pino";
import { AgentAttentionObjectives, AttentionObjectiveError } from "../attention/objectives.js";
import { toAgentPayload } from "../agent-projections.js";
import { createTestAgentClients } from "../../test-utils/fake-agent-client.js";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import { createTestAgentMessages } from "../../test-utils/agent-messages.js";
import { expect, vi } from "vitest";
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
  const retries: FinishRetry[] = [];
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
  const signals: AbortSignal[] = [];
  const acknowledgements: string[] = [];
  const stops: Array<() => void> = [];

  async function stopRefusedWatches() {
    // Exact refusals remain durable retry intents. Prove refusal and absence of
    // delivery before retiring them, so teardown cannot hide an unintended callback.
    await expect.poll(() => new Set(retries.map((retry) => retry.subscription.id)).size).toBe(2);
    for (const { error } of retries) {
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
          onRetry: (retry) => retries.push(retry),
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
    await Promise.allSettled(dispatched);
    if (mode === "parented" || mode === "independent") {
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(acknowledgements).toHaveLength(2);
      const stored = (await storage.get(callerId))?.attentionObjectives;
      expect(
        stored?.delegations.map((entry) => entry.deliveries?.map((item) => item.status)),
      ).toEqual([["consumed"], ["consumed"]]);
      expect(parentPrompts.join("\n")).toContain("EXACT_RESULT_0");
      expect(parentPrompts.join("\n")).toContain("EXACT_RESULT_1");
      expect(parentPrompts.join("\n")).not.toContain("Untrusted current message");
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
  const retries: FinishRetry[] = [];
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
  let beforeCallbackEnqueue: FinishWaitFixture["beforeCallbackEnqueue"];
  let retryDelay: FinishWaitFixture["retryDelay"];
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
    if (mode === "failed-write") {
      storage.failNextReservationWrite = true;
      // Hold the retry after the failed reservation write until the refusal is asserted.
      retryDelay = async () => {
        await retryReservation.promise;
      };
    }
    if (mode === "competing") {
      // The first watcher owns the reservation, held before enqueue, while a second arrives.
      beforeCallbackEnqueue = holdFirstReservation(async () => {
        reservationEntered.resolve();
        await returnReservation.promise;
      });
    }
    if (mode === "await-retirement") {
      // Retire the first watcher after it reserved and before it could enqueue.
      beforeCallbackEnqueue = holdFirstReservation(async () => {
        retireWatcherDuringAwait();
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
          onRetry: (retry) => retries.push(retry),
          beforeCallbackEnqueue,
          retryDelay,
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
      await expect.poll(() => retries.length > 0).toBe(true);
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
    rmSync(workdir, { recursive: true, force: true });
  }
});
