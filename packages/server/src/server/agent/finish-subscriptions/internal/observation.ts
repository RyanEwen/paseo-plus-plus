import type { AgentAttentionRequestQuery } from "@getpaseo/protocol/agent-attention";
import { ensureUnarchivedAgentLoaded } from "../../agent-loading.js";
import {
  formatFinishNotificationBody,
  finishNotificationEvents,
  type FinishNotificationReason,
} from "./notification.js";
import type { Logger } from "pino";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../../agent-storage.js";
import type { AgentMessageDelivery } from "../../agent-messages/index.js";
import { buildStoredAgentPayload, toAgentPayload } from "../../agent-projections.js";
import { serializeSnapshotWithMetadata } from "../../mcp-shared.js";
import { createHostObservationResolver, type ToolHosts } from "../../host-operations/index.js";
import { openFinishObservation } from "./observation-stream.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { AgentAttentionOutcome, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { FinishObservation, FinishSubscription } from "../index.js";

export function createFinishObservation(input: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  /** A child chosen for restart recovery reports its state only after its resume was sent. */
  waitForResume(agentId: string, signal: AbortSignal): Promise<void>;
  messages(): AgentMessageDelivery;
  hosts(): ToolHosts;
  serverId: string;
  logger: Logger;
  /**
   * Awaited after an exact callback outcome is reserved and before it is enqueued. A watcher
   * retired or superseded meanwhile releases the reservation instead of dispatching.
   */
  beforeCallbackEnqueue?(input: { record: FinishSubscription; outcomeId: string }): Promise<void>;
}): FinishObservation {
  const { agentManager, agentStorage } = input;
  function projectStored(stored: StoredAgentRecord) {
    return buildStoredAgentPayload(
      stored,
      [stored.provider],
      (provider, own) => agentManager.effectiveOptionsFor(provider, own),
      { agentAwareAttention: agentManager.agentAwareAttentionEnabled },
    );
  }
  async function exactSnapshot(agentId: string) {
    const live = agentManager.getAgent(agentId);
    if (live) return serializeSnapshotWithMetadata(agentStorage, live, input.logger);
    const stored = await agentStorage.get(agentId);
    return stored ? projectStored(stored) : null;
  }
  async function waitExact(
    agentId: string,
    signal: AbortSignal,
    attentionRequest: AgentAttentionRequestQuery,
  ) {
    if (!attentionRequest.acknowledgeOutcomeId) {
      await input.waitForResume(agentId, signal);
      await input.messages().waitForDispatch(agentId, signal);
    }
    const attentionOutcome = await agentManager.waitForAttentionOutcome({
      agentId,
      query: attentionRequest,
      signal,
      waitForSubmission: !attentionRequest.acknowledgeOutcomeId,
    });
    const final = await exactSnapshot(agentId);
    return {
      status: exactStatus(attentionOutcome?.kind),
      final,
      lastMessage: attentionOutcome?.lastMessage ?? null,
      error: attentionOutcome?.error ?? null,
      attentionOutcome,
    };
  }
  const resolver = createHostObservationResolver({
    serverId: input.serverId,
    hosts: input.hosts,
    local: {
      async wait(agentId, signal, attentionRequest) {
        if (attentionRequest) return waitExact(agentId, signal, attentionRequest);
        await input.waitForResume(agentId, signal);
        await input.messages().waitForDispatch(agentId, signal);
        signal.throwIfAborted();
        const live = agentManager.getAgent(agentId);
        if (!live) {
          const stored = await agentStorage.get(agentId);
          return {
            status: stored?.lastStatus === "error" ? "error" : "idle",
            final: stored ? projectStored(stored) : null,
            lastMessage: await agentManager.getLastAssistantMessage(agentId),
            error: stored?.lastError ?? null,
          };
        }
        const result = await agentManager.waitForAgentEvent(agentId, {
          signal,
          waitForActive: true,
        });
        const current = agentManager.getAgent(agentId);
        const status = result.permission ? "permission" : result.status;
        return {
          status: status === "permission" || status === "error" ? status : "idle",
          final: current
            ? await serializeSnapshotWithMetadata(agentStorage, current, input.logger)
            : null,
          lastMessage: result.lastMessage,
          error: current?.lastError ?? null,
        };
      },
      async observe(agentId, handler, signal, onError) {
        await input.waitForResume(agentId, signal);
        const stored = await agentStorage.get(agentId);
        let updates = Promise.resolve();
        const publish = (snapshot: AgentSnapshotPayload | null, event?: AgentStreamEvent) => {
          updates = updates
            .then(async () =>
              handler(snapshot, event, await agentManager.getLastAssistantMessage(agentId)),
            )
            .catch(onError);
        };
        signal.throwIfAborted();
        const unsubscribe = agentManager.subscribe(
          (event) => {
            if (event.type === "agent_state" && event.agent.lifecycle !== "idle")
              publish(toAgentPayload(event.agent, { title: stored?.title }));
            else if (
              event.type === "agent_stream" &&
              [
                "permission_requested",
                "permission_resolved",
                "turn_started",
                "turn_completed",
                "turn_canceled",
                "turn_failed",
              ].includes(event.event.type)
            ) {
              const current = agentManager.getAgent(agentId);
              if (current) publish(toAgentPayload(current, { title: stored?.title }), event.event);
            }
          },
          { agentId, replayState: false },
        );
        const current = agentManager.getAgent(agentId);
        if (current)
          publish(toAgentPayload(current, { title: stored?.title }), {
            type: "turn_started",
            provider: current.provider,
          });
        else publish(stored ? projectStored(stored) : null);
        const stop = () => unsubscribe();
        signal.addEventListener("abort", stop, { once: true });
        return async () => {
          signal.removeEventListener("abort", stop);
          unsubscribe();
        };
      },
    },
  });
  return {
    open: async (record, signal) => {
      if (!record.attention) return openFinishObservation(resolver, record, signal);
      return {
        next: () =>
          resolver.use(
            record.serverId,
            (host) => host.wait(record.childAgentId, signal, record.attention),
            signal,
          ),
        close: async () => {},
      };
    },
    acknowledgeExact: async (record, outcomeId, signal) => {
      const attention = record.attention;
      if (!attention) throw new Error("Missing exact finish correlation");
      await resolver.use(
        record.serverId,
        (host) =>
          host.wait(record.childAgentId, signal, { ...attention, acknowledgeOutcomeId: outcomeId }),
        signal,
      );
    },
    deliverExact: async (record, result, signal) => {
      const query = record.attention;
      const outcome = result.attentionOutcome;
      if (
        !query ||
        !outcome ||
        result.final?.id !== record.childAgentId ||
        outcome.requestId !== query.link.requestId
      )
        throw new Error("Exact finish outcome is unavailable or mismatched");
      await ensureUnarchivedAgentLoaded(record.callerAgentId, {
        agentManager,
        agentStorage,
        logger: input.logger,
      });
      signal.throwIfAborted();
      const claim = {
        agentId: record.callerAgentId,
        peer: { agentId: record.childAgentId, serverId: record.serverId ?? input.serverId },
        link: query.link,
        deliveryId: outcome.id,
      };
      const reserved = await agentManager.reserveAttentionCallback({ ...claim, outcome });
      if (reserved.status === "consumed") {
        await agentManager.persistAttentionDelivery(record.callerAgentId);
        return { outcomeId: outcome.id, terminal: isTerminalOutcome(outcome.kind) };
      }
      try {
        await input.beforeCallbackEnqueue?.({ record, outcomeId: outcome.id });
        // Archive and retirement may occur while the durable reservation is written.
        if ((await agentStorage.get(record.callerAgentId))?.archivedAt)
          throw new Error("Finish caller is archived");
        signal.throwIfAborted();
        const reason = EXACT_REASON[outcome.kind];
        const title = result.final.title ?? record.childAgentId;
        const receipt = input.messages().enqueue({
          recipientId: record.callerAgentId,
          messageId: outcome.id,
          prompt:
            formatFinishNotificationBody({
              childAgentId: record.childAgentId,
              serverId: record.serverId ?? input.serverId,
              title,
              reason,
              lastAssistantMessage: outcome.lastMessage,
              permissionRequest: outcome.permission,
            }) + (outcome.error ? `\n\n${outcome.error}` : ""),
          source: {
            kind: "agent-notification",
            agentId: record.childAgentId,
            serverId: record.serverId ?? input.serverId,
            title,
            event: finishNotificationEvents[reason],
            attention: {
              continuation: query.link,
              delivery: { outcomeId: outcome.id, deliveryId: outcome.id },
            },
          },
          activeTurnBehavior: "steer",
          unarchive: false,
        });
        await receipt.dispatched;
        await agentManager.persistAttentionDelivery(record.callerAgentId);
        return { outcomeId: outcome.id, terminal: isTerminalOutcome(outcome.kind) };
      } catch (error) {
        await agentManager.releaseAttentionCallback({ ...claim, lease: reserved.lease });
        throw error;
      }
    },
  };
}

type AttentionOutcomeKind = AgentAttentionOutcome["kind"];

/** Finish status reported for each exact outcome; a missing outcome reads as a failure. */
const EXACT_STATUS: Record<AttentionOutcomeKind, "idle" | "permission" | "error"> = {
  finished: "idle",
  permission: "permission",
  error: "error",
  canceled: "error",
  rejected: "error",
};
/** Caller-facing finish reason for each exact outcome. A rejected request reads as an error. */
const EXACT_REASON: Record<AttentionOutcomeKind, FinishNotificationReason> = {
  finished: "finished",
  permission: "needs permission",
  error: "errored",
  canceled: "was canceled",
  rejected: "errored",
};

function exactStatus(kind: AttentionOutcomeKind | undefined): "idle" | "permission" | "error" {
  return kind === undefined ? "error" : EXACT_STATUS[kind];
}
/** A permission checkpoint keeps the watch open; every other outcome ends it. */
function isTerminalOutcome(kind: AttentionOutcomeKind): boolean {
  return kind !== "permission";
}
