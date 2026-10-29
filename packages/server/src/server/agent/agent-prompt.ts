import type { AgentAttentionRequestQuery } from "@getpaseo/protocol/agent-attention";
import { toAgentPayload, buildStoredAgentPayload } from "./agent-projections.js";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import {
  prepareAgentMessage,
  type AgentPromptSource,
  type AgentMessageDelivery,
} from "./agent-messages/index.js";
import type { Logger } from "pino";
import { randomUUID } from "node:crypto";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import {
  getParentAgentIdFromLabels,
  getParentAddressFromLabels,
} from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import type { AgentMessageAttention } from "@getpaseo/protocol/agent-attention";
import type { AttentionAdmission } from "./attention/objectives.js";

/** Classify at the daemon-owned prompt entrypoint, before provider text encoding loses provenance. */
function promptAttention(
  source: AgentPromptSource | undefined,
  requestId: string,
): AttentionAdmission {
  if (!source) return { kind: "human", requestId };
  return {
    kind: "agent",
    requestId,
    requester: {
      agentId: source.agentId,
      ...(source.serverId ? { serverId: source.serverId } : {}),
    },
    attention: source.attention,
  };
}

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> & {
  reloadAgentSession(agentId: string): Promise<unknown>;
};

export interface StartAgentRunOptions {
  /** Called after selecting the run, before consuming its events. */
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
  replaceRunning?: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
}

export type PromptDispatchDisposition = "out_of_band" | "steered" | "turn_started";

async function steerOrReplaceActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<
  | { disposition: "steered" }
  | {
      disposition: "turn_started";
      replaced: boolean;
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
    }
  | null
> {
  if (options?.activeTurnBehavior !== "steer") {
    return null;
  }
  const steerOptions = options.clearPendingPermissions
    ? { ...options.runOptions, clearPendingPermissions: true }
    : options.runOptions;
  const result = await agentManager.steerOrReplaceActiveTurn(agentId, prompt, steerOptions);
  if (result.status === "steered") {
    return { disposition: "steered" };
  }
  if (result.status === "replaced" || result.status === "started") {
    return {
      disposition: "turn_started",
      replaced: result.status === "replaced",
      iterator: result.iterator,
    };
  }
  return null;
}

async function startOrReplaceRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<{
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  replaced: boolean;
}> {
  const replaced = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, options?.runOptions)
    : agentManager.streamAgent(agentId, prompt, options?.runOptions);
  return { iterator, replaced };
}

async function drainAgentRunIterator(
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>,
): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      turnId: snapshot?.activeForegroundTurnId ?? undefined,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    options?.onDispatch?.("out_of_band");
    return { disposition: "out_of_band" };
  }
  try {
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  } catch (error) {
    if (!isStaleProviderSessionError(error)) throw error;
    logger.info({ agentId, err: error }, "Provider session went stale; reopening from persistence");
    // The live session belongs to a retired plugin runtime. Reload swaps in a
    // fresh session on the current runtime while preserving history and labels.
    await agentManager.reloadAgentSession(agentId);
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  }
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const snapshot = agentManager.getAgent(agentId);
  const steered = await steerOrReplaceActiveRun(agentManager, agentId, prompt, options);
  if (steered?.disposition === "steered") {
    options?.onDispatch?.("steered");
    return steered;
  }
  const { iterator, replaced } = steered
    ? { iterator: steered.iterator, replaced: steered.replaced }
    : await startOrReplaceRun(agentManager, agentId, prompt, options);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace: replaced,
    },
    "agent.session.start_stream.iterator_returned",
  );
  options?.onDispatch?.("turn_started");
  void (async () => {
    try {
      try {
        await drainAgentRunIterator(iterator);
      } catch (error) {
        if (!isStaleProviderSessionError(error)) throw error;
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        await agentManager.reloadAgentSession(agentId);
        const retry = await startOrReplaceRun(agentManager, agentId, prompt, options);
        await drainAgentRunIterator(retry.iterator);
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  return { disposition: "turn_started" };
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

export interface SendPromptToAgentParams {
  onDispatch?: StartAgentRunOptions["onDispatch"];
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  source?: AgentPromptSource;
  messageId?: string;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  /** See {@link StartAgentRunOptions.clearPendingPermissions}. */
  clearPendingPermissions?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentStorage: AgentStorage;
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  source?: AgentPromptSource;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * Outer bound on a run reaching "started" after dispatch.
 *
 * This wraps provider startup, so it MUST stay larger than the slowest provider's own
 * startup budget — otherwise it aborts a start the provider was still allowed to be
 * working on, and the provider's budget can never apply. OpenCode is the slowest today:
 * up to 30s for the server to boot (OPENCODE_SERVER_STARTUP_TIMEOUT_MS) and then a
 * session.create on the same budget, so this is deliberately set well above 30s.
 *
 * Not derived from the provider constant on purpose: this module is provider-agnostic
 * and must not depend on a specific provider's internals.
 */
const AGENT_RUN_START_TIMEOUT_MS = 60_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const provider = agentManager.getAgent(agentId)?.provider ?? "provider";
  const startAbort = new AbortController();
  const startTimeout = setTimeout(
    () =>
      startAbort.abort(
        new Error(
          `${provider} run did not start within ${AGENT_RUN_START_TIMEOUT_MS / 1000} seconds (phase: run start)`,
        ),
      ),
    AGENT_RUN_START_TIMEOUT_MS,
  );

  try {
    await agentManager.waitForAgentRunStart(agentId, {
      signal: signal ? AbortSignal.any([startAbort.signal, signal]) : startAbort.signal,
    });
  } finally {
    clearTimeout(startTimeout);
  }
}

async function resolvePromptSource(
  source: AgentPromptSource | undefined,
  manager: Pick<AgentManager, "getAgent">,
  storage: AgentStorage,
): Promise<AgentPromptSource | undefined> {
  if (!source || source.title) return source;
  const title = (
    manager.getAgent(source.agentId)?.config.title ?? (await storage.get(source.agentId))?.title
  )?.trim();
  return title ? { ...source, title } : source;
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns the normal turn-start disposition) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const source = await resolvePromptSource(params.source, params.agentManager, params.agentStorage);
  const delivery = prepareAgentMessage(params.prompt, source, params.messageId);
  return sendPreparedPromptToAgent({
    ...params,
    prompt: delivery.prompt,
    runOptions: {
      ...params.runOptions,
      ...(delivery.messageId ? { clientMessageId: delivery.messageId } : {}),
      attention: params.runOptions?.attention ?? [
        promptAttention(source, delivery.messageId ?? params.messageId ?? randomUUID()),
      ],
    },
  });
}

/** Dispatch daemon-prepared context without reclassifying it as human input. */
export async function sendPreparedPromptToAgent(
  params: Omit<SendPromptToAgentParams, "source" | "messageId">,
): Promise<{ disposition: PromptDispatchDisposition }> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  let archivedAtToRestore: string | null = null;
  if (record?.archivedAt) {
    if (!unarchive) {
      return { disposition: "turn_started" };
    }
    if (await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId)) {
      archivedAtToRestore = record.archivedAt;
    }
  }

  try {
    await ensureAgentLoaded(params.agentId, {
      agentManager: params.agentManager,
      agentStorage: params.agentStorage,
      logger: params.logger,
    });
  } catch (error) {
    // A send that could not load the agent leaves it where it was: still archived.
    // Concurrent sends share this load, so none of them holds a live session.
    if (archivedAtToRestore) {
      await params.agentManager.archiveSnapshot(params.agentId, archivedAtToRestore);
    }
    throw error;
  }

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: true,
    onDispatch: params.onDispatch,
    activeTurnBehavior: params.activeTurnBehavior,
    clearPendingPermissions: params.clearPendingPermissions,
    runOptions: params.runOptions,
  });
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const delivery = prepareAgentMessage(
    params.prompt,
    await resolvePromptSource(params.source, params.agentManager, params.agentStorage),
    params.source?.attention?.requesterObjective?.requestId ?? params.runOptions?.clientMessageId,
  );
  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    delivery.prompt,
    params.logger,
    {
      runOptions: {
        ...params.runOptions,
        clientMessageId: delivery.messageId,
        attention: [promptAttention(params.source, delivery.messageId ?? randomUUID())],
      },
    },
  );

  if (dispatchResult.disposition === "turn_started") {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

export interface SetupFinishNotificationParams {
  attention?: AgentMessageAttention;
  agentMessages: AgentMessageDelivery;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  childServerId?: string;
  requireParentOwnership?: boolean;
  /** Retain pre-dispatch outcomes only when dispatch keeps the existing turn. */
  dispatchResult?: Promise<PromptDispatchDisposition | false>;
  /** A replacement must observe its new start, not the displaced running snapshot. */
  waitForTurnStart?: boolean;
  logger: Logger;
}

type FinishNotificationReason =
  | "finished"
  | "errored"
  | "needs permission"
  | "was closed"
  | "was canceled";

const finishNotificationEvents = {
  finished: "finished",
  errored: "errored",
  "needs permission": "permission-required",
  "was closed": "closed",
  // Use the existing failure event so older clients still parse agent-message metadata.
  "was canceled": "errored",
} as const;

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  serverId?: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.serverId) sections.push(`Server: ${params.serverId}`);
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          ...(params.serverId ? { serverId: params.serverId } : {}),
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

interface NotifySafelyOptions {
  terminal?: boolean;
  permissionRequest?: AgentPermissionRequest;
}

// Pending follow-ups coexist until acknowledgement. A successful dispatch replaces
// every earlier observation for the caller/child pair; a failure removes only itself.
interface ArmedFinishNotification {
  stop(): void;
  supersedeWhen(accepted: Promise<boolean>): void;
}

type AttentionCallbackClaim = Omit<
  Parameters<AgentManager["reserveAttentionCallback"]>[0],
  "outcome"
>;

const armedFinishNotifications = new WeakMap<
  AgentManager,
  Map<string, Set<ArmedFinishNotification>>
>();

/** Creation waits and accepted follow-ups share notification ownership. */
export function setupFinishWait(params: {
  attention?: AgentMessageAttention;
  agentMessages: AgentMessageDelivery;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  originServerId?: string;
  childServerId?: string;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  wait(
    signal: AbortSignal,
    attentionRequest?: AgentAttentionRequestQuery,
  ): Promise<WaitForFinishResult>;
  afterPermission(requestId: string, signal: AbortSignal): Promise<void>;
  logger: Logger;
}): () => void {
  const controller = new AbortController();
  const byManager =
    armedFinishNotifications.get(params.agentManager) ??
    new Map<string, Set<ArmedFinishNotification>>();
  armedFinishNotifications.set(params.agentManager, byManager);
  const watchIdentity = [params.childServerId ?? null, params.childAgentId, params.callerAgentId];
  // Exact requests coexist: a later request must not discard an earlier immutable result.
  if (params.attention?.continuation) watchIdentity.push(params.attention.continuation.requestId);
  const key = JSON.stringify(watchIdentity);
  const registrations = byManager.get(key) ?? new Set<ArmedFinishNotification>();
  byManager.set(key, registrations);
  for (const previous of registrations) previous.stop();
  byManager.set(key, registrations);
  let superseded = Promise.resolve(false);
  const stop = () => {
    controller.abort();
    registrations.delete(registration);
    if (registrations.size === 0 && byManager.get(key) === registrations) byManager.delete(key);
  };
  const registration: ArmedFinishNotification = {
    stop,
    supersedeWhen(accepted) {
      superseded = superseded.then(async (prior) => prior || (await accepted));
    },
  };
  registrations.add(registration);
  let attentionRequest: AgentAttentionRequestQuery | undefined = params.attention?.continuation
    ? {
        link: params.attention.continuation,
        requester: params.agentManager.attentionRequester(params.callerAgentId),
      }
    : undefined;

  /** Deliver one owned reservation, keeping the post-await ownership check synchronous with enqueue. */
  async function deliverReservedOutcome(input: {
    claim: AttentionCallbackClaim;
    outcome: NonNullable<WaitForFinishResult["attentionOutcome"]>;
    title: string;
    lease: symbol;
  }): Promise<boolean> {
    const { claim, outcome, title, lease } = input;
    let reason: FinishNotificationReason = "errored";
    if (outcome.kind === "permission") reason = "needs permission";
    if (outcome.kind === "finished") reason = "finished";
    if (outcome.kind === "canceled") reason = "was canceled";
    try {
      let observedSupersession = superseded;
      for (;;) {
        const isSuperseded = await observedSupersession;
        // Retirement and a newer supersession can arrive while the observed promise settles.
        // Keep the final ownership check synchronous with enqueue, without another await.
        if (controller.signal.aborted || isSuperseded) {
          await params.agentManager.releaseAttentionCallback({ ...claim, lease });
          return false;
        }
        if (observedSupersession === superseded) break;
        observedSupersession = superseded;
      }
      const receipt = params.agentMessages.enqueue({
        recipientId: params.callerAgentId,
        messageId: claim.deliveryId,
        prompt:
          formatFinishNotificationBody({
            childAgentId: params.childAgentId,
            serverId: params.childServerId,
            title,
            reason,
            lastAssistantMessage: outcome.lastMessage,
            permissionRequest: outcome.permission,
          }) + (outcome.error ? `\n\n${outcome.error}` : ""),
        source: {
          kind: "agent-notification",
          agentId: params.childAgentId,
          serverId: params.childServerId,
          title,
          event: finishNotificationEvents[reason],
          attention: {
            continuation: claim.link,
            delivery: { outcomeId: outcome.id, deliveryId: claim.deliveryId },
          },
        },
        activeTurnBehavior: "steer",
        unarchive: false,
      });
      await receipt.dispatched;
      // Actual provider admission consumes the reservation. Persist it before target acknowledgement.
      await params.agentManager.persistAttentionDelivery(params.callerAgentId);
      return true;
    } catch (error) {
      await params.agentManager.releaseAttentionCallback({ ...claim, lease });
      throw error;
    }
  }

  /** Return an acknowledgement ID only after exact evidence and durable source delivery succeed. */
  async function deliverAttentionOutcome(
    result: WaitForFinishResult,
    query: AgentAttentionRequestQuery,
  ): Promise<string | null> {
    const outcome = result.attentionOutcome;
    if (
      !outcome ||
      result.final?.id !== params.childAgentId ||
      outcome.requestId !== query.link.requestId
    )
      return null;
    const claim = {
      agentId: params.callerAgentId,
      peer: { agentId: params.childAgentId, serverId: params.childServerId },
      link: query.link,
      deliveryId: outcome.id,
    };
    const reserved = await params.agentManager.reserveAttentionCallback({ ...claim, outcome });
    if (reserved.status === "consumed") return outcome.id;
    const delivered = await deliverReservedOutcome({
      claim,
      outcome,
      title: result.final?.title ?? params.childAgentId,
      lease: reserved.lease,
    });
    return delivered ? outcome.id : null;
  }

  /** Forward a legacy result only after the watcher has applied its unchanged parent guard. */
  async function deliverLegacyOutcome(result: WaitForFinishResult): Promise<boolean> {
    if (result.status === "timeout") return false;
    const reason = { idle: "finished", error: "errored", permission: "needs permission" }[
      result.status
    ] as FinishNotificationReason;
    const permissionRequest = result.final?.pendingPermissions[0];
    params.agentMessages.enqueue({
      recipientId: params.callerAgentId,
      prompt: formatFinishNotificationBody({
        childAgentId: params.childAgentId,
        serverId: params.childServerId,
        title: result.final?.title ?? params.childAgentId,
        reason,
        lastAssistantMessage: result.lastMessage,
        permissionRequest,
      }),
      source: {
        kind: "agent-notification",
        agentId: params.childAgentId,
        serverId: params.childServerId,
        title: result.final?.title ?? params.childAgentId,
        event: finishNotificationEvents[reason],
        attention: params.attention,
      },
      activeTurnBehavior: "steer",
      unarchive: false,
    });
    if (result.status !== "permission" || !permissionRequest) return false;
    await params.afterPermission(permissionRequest.id, controller.signal);
    return true;
  }

  async function watch(): Promise<void> {
    while (!controller.signal.aborted) {
      const result = await params.wait(controller.signal, attentionRequest);
      if (controller.signal.aborted || (await superseded) || result.status === "timeout") return;
      const parent = getParentAddressFromLabels(
        result.final?.labels,
        params.childServerId ?? "self",
      );
      if ((await params.agentStorage.get(params.callerAgentId))?.archivedAt) return;
      if (attentionRequest) {
        const acknowledgeOutcomeId = await deliverAttentionOutcome(result, attentionRequest);
        if (acknowledgeOutcomeId === null) return;
        attentionRequest = {
          link: attentionRequest.link,
          requester: attentionRequest.requester,
          acknowledgeOutcomeId,
        };
        continue;
      }

      if (
        params.requireParentOwnership !== false &&
        (parent?.agentId !== params.callerAgentId ||
          parent.serverId !== (params.originServerId ?? "self"))
      )
        return;

      const continueWatching = await deliverLegacyOutcome(result);
      if (!continueWatching) return;
    }
  }
  void watch()
    .catch((error) => {
      if (!controller.signal.aborted)
        params.logger.warn(
          { err: error, agentId: params.childAgentId },
          "Child finish wait stopped",
        );
    })
    .finally(stop);
  return stop;
}

export function setupFinishNotification(params: SetupFinishNotificationParams): () => void {
  if (params.attention?.continuation) {
    return setupFinishWait({
      ...params,
      originServerId: params.childServerId,
      requireParentOwnership: params.requireParentOwnership ?? false,
      wait: async (signal, attentionRequest) => {
        if (!attentionRequest) throw new Error("Missing attention request correlation");
        if (params.dispatchResult && !(await params.dispatchResult))
          return {
            status: "error",
            final: null,
            error: null,
            lastMessage: null,
            attentionOutcome: null,
          };
        const attentionOutcome = await params.agentManager.waitForAttentionOutcome({
          agentId: params.childAgentId,
          query: attentionRequest,
          signal,
          waitForSubmission: attentionRequest.acknowledgeOutcomeId === undefined,
        });
        const record = await params.agentStorage.get(params.childAgentId);
        const live = params.agentManager.getAgent(params.childAgentId);
        let final: WaitForFinishResult["final"] = null;
        if (live) {
          final = toAgentPayload(live, { title: record?.title });
        } else if (record) {
          final = buildStoredAgentPayload(record, params.agentManager.getRegisteredProviderIds(), {
            agentAwareAttention: params.agentManager.agentAwareAttentionEnabled,
          });
        }
        let status: "idle" | "error" | "permission" = "error";
        if (attentionOutcome?.kind === "finished") status = "idle";
        if (attentionOutcome?.kind === "permission") status = "permission";
        return {
          status,
          final,
          lastMessage: attentionOutcome?.lastMessage ?? null,
          error: attentionOutcome?.error ?? null,
          attentionOutcome,
        };
      },
      afterPermission: async () => {},
    });
  }
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    waitForTurnStart = false,
    logger,
  } = params;
  let hasSeenRunning = false;
  let hasSeenTurn = false;
  let stopped = false;
  const notifiedPermissionRequestIds = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let notificationQueue = Promise.resolve();

  const armedByManager = armedFinishNotifications.get(agentManager) ?? new Map();
  armedFinishNotifications.set(agentManager, armedByManager);
  const armedKey = JSON.stringify([params.childServerId ?? null, childAgentId, callerAgentId]);
  const registrations = armedByManager.get(armedKey) ?? new Set<ArmedFinishNotification>();
  armedByManager.set(armedKey, registrations);
  const previous = [...registrations];
  let superseded = Promise.resolve(false);
  let dispatchPending = Boolean(params.dispatchResult);
  const registration: ArmedFinishNotification = {
    stop,
    supersedeWhen(accepted) {
      superseded = superseded.then(
        async (alreadySuperseded) => alreadySuperseded || (await accepted),
      );
    },
  };
  registrations.add(registration);
  if (params.dispatchResult) {
    const dispatchAccepted = params.dispatchResult.then((result) => result !== false);
    for (const observer of previous) observer.supersedeWhen(dispatchAccepted);
    void params.dispatchResult.then((accepted) => {
      dispatchPending = false;
      if (accepted) {
        for (const observer of previous) observer.stop();
        if (stopped || accepted === "turn_started") stop();
      } else {
        stop();
      }
      return undefined;
    });
  } else {
    for (const observer of previous) {
      observer.supersedeWhen(Promise.resolve(true));
      observer.stop();
    }
  }

  function stop(): void {
    stopped = true;
    unsubscribe?.();
    // Pending observations remain visible to overlapping sends until acknowledgement.
    if (!dispatchPending) {
      registrations.delete(registration);
      if (registrations.size === 0 && armedByManager.get(armedKey) === registrations) {
        armedByManager.delete(armedKey);
      }
    }
  }

  async function notify(
    reason: FinishNotificationReason,
    permissionRequest?: AgentPermissionRequest,
  ): Promise<void> {
    if (params.dispatchResult) {
      const result = await params.dispatchResult;
      if (result === false || result === "turn_started") return;
    }
    if (await superseded) return;
    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      return;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage,
      permissionRequest,
    });

    params.agentMessages.enqueue({
      recipientId: callerAgentId,
      prompt: body,
      source: {
        kind: "agent-notification",
        agentId: childAgentId,
        title,
        event: finishNotificationEvents[reason],
        attention: params.attention,
      },
      activeTurnBehavior: "steer",
      unarchive: false,
    });
  }

  function notifySafely(reason: FinishNotificationReason, options: NotifySafelyOptions = {}): void {
    if (stopped) return;
    if (options.terminal ?? true) stop();
    notificationQueue = notificationQueue
      .then(() => notify(reason, options.permissionRequest))
      .catch((error) => {
        logger.error(
          { err: error, childAgentId, callerAgentId, reason },
          "Failed to notify caller agent",
        );
      });
  }

  function observeState(agent: ManagedAgent): void {
    for (const requestId of notifiedPermissionRequestIds) {
      if (!agent.pendingPermissions.has(requestId)) {
        notifiedPermissionRequestIds.delete(requestId);
      }
    }
    if (agent.lifecycle === "running") {
      if (waitForTurnStart && !hasSeenTurn) return;
      hasSeenTurn = true;
      if (agent.pendingPermissions.size === 0) {
        hasSeenRunning = true;
      }
      return;
    }
    // Prior terminal state is not this task's outcome. A failure before turn start
    // is reported by the dispatch acknowledgement instead of a finish callback.
    if (agent.lifecycle === "error" && hasSeenTurn) {
      notifySafely("errored");
      return;
    }
    // Idle is published before the terminal stream event for both completion
    // and cancellation. Let that event identify the outcome instead.
    if (agent.lifecycle === "closed") {
      notifySafely("was closed");
      return;
    }
    return;
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (stopped) {
        return;
      }

      if (event.type === "agent_state") {
        observeState(event.agent);
        return;
      }

      if (event.type === "timeline_replacement") {
        return;
      }

      if (event.event.type === "turn_started") {
        hasSeenTurn = true;
        hasSeenRunning = true;
        return;
      }

      if (event.event.type === "turn_completed" || event.event.type === "turn_canceled") {
        // Replacing a turn keeps the child running through the displaced turn's
        // cancellation. The task settles only when the child becomes idle.
        if (agentManager.getAgent(childAgentId)?.lifecycle !== "idle") return;
        if (event.event.type === "turn_completed" && hasSeenRunning) {
          notifySafely("finished");
        } else if (event.event.type === "turn_canceled" && hasSeenTurn) {
          notifySafely("was canceled");
        }
        return;
      }

      if (event.event.type === "permission_requested") {
        // A permission pause is an intermediate checkpoint. Forget the run
        // observed before it so an idle state during follow-up startup cannot
        // masquerade as the final completion.
        hasSeenRunning = false;
        if (!notifiedPermissionRequestIds.has(event.event.request.id)) {
          notifiedPermissionRequestIds.add(event.event.request.id);
          notifySafely("needs permission", {
            terminal: false,
            permissionRequest: event.event.request,
          });
        }
        return;
      }

      if (event.event.type === "permission_resolved") {
        notifiedPermissionRequestIds.delete(event.event.requestId);
        const childAgent = agentManager.getAgent(childAgentId);
        if (childAgent?.pendingPermissions.size === 0) {
          hasSeenRunning = childAgent.lifecycle === "running";
        }
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    stop();
    return stop;
  }
  if (childSnapshot.lifecycle === "running" && !waitForTurnStart) {
    hasSeenTurn = true;
    hasSeenRunning = true;
  }
  return stop;
}
