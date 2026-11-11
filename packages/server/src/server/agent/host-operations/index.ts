import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { parentAddressLabels } from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior, AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DaemonClient,
  DaemonConnectionError,
  type FetchWorkspacesEntry,
  type WaitForFinishResult,
} from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import type { HostDirectory } from "@getpaseo/protocol/hosts";
import { OWNER_PERMISSIONS } from "../../authorization/index.js";
import type { ConnectedHosts } from "../../connected-hosts/index.js";
import { resolveRequiredProviderModel } from "../mcp-shared.js";
import { selectAgentListItems } from "../agent-projections.js";
import { summarizeAgentActivity } from "../activity-curator.js";
import {
  inheritAgentBackground,
  inheritWorkspaceBackground,
  type BackgroundCaller,
} from "../create-agent/intent.js";
import { expandUserPath } from "../../path-utils.js";
import type { PaseoToolExecutionContext, PaseoToolResult } from "../tools/types.js";
import type {
  AgentAttentionPeer,
  AgentAttentionRequestQuery,
  AgentMessageAttention,
} from "@getpaseo/protocol/agent-attention";

/** Internal dispatch provenance is stripped by the MCP catalog before returning the tool result. */
export interface AgentHostOperationResult extends PaseoToolResult {
  attention?: AgentMessageAttention;
}

export class HostOperationRejectedError extends Error {
  readonly code: unknown;
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "HostOperationRejectedError";
    this.code = error instanceof Error && "code" in error ? error.code : undefined;
  }
}
/** A destination answered a delegated create with an agent other than the reserved identity. */
export class DelegatedIdentityMismatchError extends Error {
  constructor(
    readonly expectedAgentId: string,
    readonly returnedAgentId: string,
  ) {
    super("Host returned a different agent identity for the delegated request");
    this.name = "DelegatedIdentityMismatchError";
  }
}
function isAmbiguousPromptFailure(error: unknown): boolean {
  if (error instanceof DaemonConnectionError) return true;
  return error instanceof Error && error.message.startsWith("Timeout waiting for message");
}
export type HostOperation = (
  input: Record<string, unknown>,
  context: PaseoToolExecutionContext,
) => Promise<AgentHostOperationResult>;
export interface HostOperations {
  createAgent: HostOperation;
  createWorkspace: HostOperation;
  listWorkspaces: HostOperation;
  sendPrompt: HostOperation;
  getStatus: HostOperation;
  getActivity: HostOperation;
  listAgents: HostOperation;
}
/** Connection authority at the host boundary, independent of child lifecycle. */
export class HostObservationError extends Error {
  constructor(
    readonly reason: "connecting" | "unreachable" | "removed",
    cause?: unknown,
  ) {
    super(`Host observation ${reason}`, { cause });
    this.name = "HostObservationError";
  }
}
export interface HostObservation {
  wait(
    agentId: string,
    signal: AbortSignal,
    attentionRequest?: AgentAttentionRequestQuery,
  ): Promise<WaitForFinishResult>;
  observe(
    agentId: string,
    handler: (
      snapshot: AgentSnapshotPayload | null,
      event?: AgentStreamEvent,
      lastMessage?: string | null,
    ) => void,
    signal: AbortSignal,
    onError: (error: unknown) => void,
  ): Promise<() => Promise<void>>;
}
export interface ToolHosts {
  directory(): Promise<HostDirectory>;
  use<T>(
    serverId: string,
    action: (client: DaemonClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

/** Daemon MCP has the daemon's authority, bounded by the destination's admission of its link. */
export function createToolHosts(hosts: ConnectedHosts): ToolHosts {
  return {
    directory: () => hosts.list(),
    async use(serverId, action, signal) {
      const lifetime = new AbortController();
      let routeFailure: unknown;
      const transportFactory: DaemonTransportFactory = () => {
        const opens = new Set<() => void>();
        const closes = new Set<(event?: unknown) => void>();
        const errors = new Set<(event: unknown) => void>();
        const messages = new Set<(data: unknown, binary: boolean) => void>();
        let closed = false;
        let route: Awaited<ReturnType<ConnectedHosts["openRoute"]>> | undefined;
        void hosts
          .openRoute({
            serverId,
            scopeId: randomUUID(),
            sourceId: "mcp",
            originSessionId: "mcp",
            permissions: OWNER_PERMISSIONS,
            signal: signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal,
            frame: (data) => {
              for (const listener of messages) listener(data, typeof data !== "string");
            },
            ended: (code, message) => {
              for (const listener of errors)
                listener(Object.assign(new Error(message), { code, serverId }));
              for (const listener of closes) listener();
            },
          })
          .then((opened) => {
            route = opened;
            if (closed) opened.close();
            else for (const listener of opens) listener();
            return undefined;
          })
          .catch((error) => {
            routeFailure = error;
            for (const listener of errors) listener(error);
            for (const listener of closes) listener(error);
          });
        return {
          send: (data) => {
            if (!route) throw new Error("Host route is not open");
            route.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
          },
          close: () => {
            closed = true;
            route?.close();
          },
          onOpen: (listener) => {
            opens.add(listener);
            return () => opens.delete(listener);
          },
          onClose: (listener) => {
            closes.add(listener);
            return () => closes.delete(listener);
          },
          onError: (listener) => {
            errors.add(listener);
            return () => errors.delete(listener);
          },
          onMessage: (listener) => {
            messages.add(listener);
            return () => messages.delete(listener);
          },
        };
      };
      const client = new DaemonClient({
        url: "ws://host-route/ws",
        clientId: randomUUID(),
        transportFactory,
        reconnect: { enabled: false },
      });
      const stop = () => void client.close();
      signal?.addEventListener("abort", stop, { once: true });
      try {
        signal?.throwIfAborted();
        await client.connect().catch((error) => {
          // The action has not run; no application request could have been transmitted.
          throw new HostOperationRejectedError(routeFailure ?? error);
        });
        return await action(client);
      } finally {
        signal?.removeEventListener("abort", stop);
        lifetime.abort();
        await client.close();
      }
    },
  };
}

const remoteCreate = z
  .object({
    provider: z.string().min(1),
    title: z.string().trim().min(1).max(60),
    initialPrompt: z.string().min(1),
    workspaceId: z.string().min(1),
    labels: z.record(z.string(), z.string()).optional(),
    notifyOnFinish: z.boolean().optional(),
    background: z.boolean().optional(),
    idempotencyKey: z.string().optional(),
    objectiveId: z.string().optional(),
    settings: z
      .object({
        modeId: z.string().optional(),
        thinkingOptionId: z.string().optional(),
        features: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
  })
  .strict();
const result = (structuredContent: unknown): PaseoToolResult => ({
  content: [],
  structuredContent,
});

export function createHostResolver(input: {
  serverId: string;
  local: HostOperations;
  hosts: () => ToolHosts;
  callerAgentId?: string;
  /** The destination can't see the caller, so its background defaults resolve before routing. */
  caller: () => BackgroundCaller | null;
  lockedCwd?: string;
  prepareAttention?: (input: {
    recipient: AgentAttentionPeer;
    objectiveId?: string;
    requestId?: string;
  }) => Promise<AgentMessageAttention | undefined>;
}) {
  /**
   * Stable caller-selected IDs preserve creation idempotency across tool retries and restarts.
   *
   * The sha256 is laid out as an RFC 9562 version 8 UUID (8-4-8xxx-8xxx-12: version nibble 8,
   * variant bits 10) so it passes the z.uuid() check on create_agent_request.agentId.
   */
  function delegatedAgentId(destination: string, key?: string): string {
    if (!key) return randomUUID();
    const hex = createHash("sha256")
      .update(
        JSON.stringify(["agent-attention", input.serverId, input.callerAgentId, destination, key]),
      )
      .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
  /**
   * Reserve a remote create's delegated identity and objective metadata. Only an agent caller on
   * a host that accepts caller-selected IDs gets them; otherwise every field is empty, the host
   * creates the child as upstream does, and its finish watch registers after creation.
   *
   * @returns The reserved identity, its objective metadata, and the create request fields that
   * carry them.
   */
  async function prepareDelegation(
    client: DaemonClient,
    destination: string,
    parsed: { idempotencyKey?: string; objectiveId?: string },
  ) {
    if (!input.callerAgentId || !client.supportsCallerSelectedCreationIds()) {
      return { agentId: undefined, attention: undefined, request: {} };
    }
    const agentId = delegatedAgentId(destination, parsed.idempotencyKey);
    const attentionRequestId = parsed.idempotencyKey
      ? delegatedAgentId(destination, `attention:${parsed.idempotencyKey}`)
      : undefined;
    const attention = await input.prepareAttention?.({
      recipient: { serverId: destination, agentId },
      objectiveId: parsed.objectiveId,
      requestId: attentionRequestId,
    });
    return {
      agentId,
      attention,
      request: {
        agentId,
        sourceAgentId: input.callerAgentId,
        sourceAgentServerId: input.serverId,
        agentAttention: attention,
        clientMessageId: attention?.requesterObjective?.requestId,
      },
    };
  }

  return {
    directory: () => input.hosts().directory(),
    async use<T>(
      serverId: string | undefined,
      action: (host: HostOperations) => Promise<T>,
      beforeDispatch?: (input: {
        agentId: string;
        attention?: AgentMessageAttention;
        requireParentOwnership?: boolean;
      }) => Promise<void>,
    ): Promise<T> {
      const destination = serverId ?? input.serverId;
      if (destination === input.serverId) return action(input.local);
      if (input.lockedCwd)
        throw new Error("This caller is restricted to its local working directory");
      return input.hosts().use(destination, async (client) =>
        action({
          async createAgent(args) {
            const parsed = remoteCreate.parse(args);
            const delegation = await prepareDelegation(client, destination, parsed);
            const { agentId, attention } = delegation;
            const { provider, model } = resolveRequiredProviderModel(parsed.provider);
            const workspace = await client.findWorkspace(parsed.workspaceId);
            if (!workspace) throw new Error(`Workspace ${parsed.workspaceId} not found`);
            const labels = {
              ...parsed.labels,
              ...(input.callerAgentId
                ? parentAddressLabels({ agentId: input.callerAgentId, serverId: input.serverId })
                : {}),
            };
            if (agentId)
              await beforeDispatch?.({ agentId, attention, requireParentOwnership: true });
            const snapshot = await client.createAgent({
              ...delegation.request,
              config: {
                provider,
                model,
                cwd: workspace.workspaceDirectory,
                title: parsed.title,
                modeId: parsed.settings?.modeId,
                thinkingOptionId: parsed.settings?.thinkingOptionId,
                featureValues: parsed.settings?.features,
              },
              workspaceId: parsed.workspaceId,
              // Older hosts reject any background with a workspaceId, so a visible create omits it.
              ...(inheritAgentBackground(parsed.background, input.caller())
                ? { background: true }
                : {}),
              labels,
              initialPrompt: parsed.initialPrompt,
              idempotencyKey: parsed.idempotencyKey,
            });
            if (agentId && snapshot.id !== agentId) {
              throw new DelegatedIdentityMismatchError(agentId, snapshot.id);
            }
            if (!agentId && input.callerAgentId) {
              await beforeDispatch?.({ agentId: snapshot.id, requireParentOwnership: true });
            }
            return {
              ...result({
                agentId: snapshot.id,
                type: snapshot.provider,
                status: snapshot.status,
                cwd: snapshot.cwd,
                workspaceId: snapshot.workspaceId,
                currentModeId: snapshot.currentModeId,
                availableModes: snapshot.availableModes,
              }),
              attention,
            };
          },
          async sendPrompt(args) {
            const target = (
              await client.fetchAgent(z.string().parse(args.agentId)).catch((error) => {
                throw new HostOperationRejectedError(error);
              })
            )?.agent;
            if (!target)
              throw new HostOperationRejectedError(
                new Error(`Agent ${String(args.agentId)} not found`),
              );
            const agentId = target.id;
            const attention = await input.prepareAttention?.({
              recipient: { serverId: destination, agentId },
              objectiveId: z.string().optional().parse(args.objectiveId),
            });
            // Human sends retain the established mode RPC on older connected hosts.
            // Agent sends apply their requested mode when the recipient dispatches the batch.
            if (!input.callerAgentId && args.sessionMode !== undefined) {
              await client.setAgentMode(agentId, args.sessionMode as string);
            }
            await beforeDispatch?.({ agentId, attention });
            const receipt = await client
              .sendMessage(agentId, args.prompt as string, {
                sessionMode: input.callerAgentId
                  ? (args.sessionMode as string | undefined)
                  : undefined,
                agentAttention: attention,
                messageId: attention?.requesterObjective?.requestId,
                sourceAgentId: input.callerAgentId,
                sourceAgentServerId: input.callerAgentId ? input.serverId : undefined,
                activeTurnBehavior:
                  (args.activeTurnBehavior as ActiveTurnBehavior | undefined) ??
                  (input.callerAgentId ? "steer" : "interrupt"),
              })
              .catch((error) => {
                if (isAmbiguousPromptFailure(error)) throw error;
                throw new HostOperationRejectedError(error);
              });
            return result({
              success: true,
              ...receipt,
              status: target.status,
              guidance:
                receipt.deliveryStatus === "queued"
                  ? "Queued for delivery after two quiet seconds. You will get notified when the prompted agent finishes, errors, or needs permission unless notifyOnFinish is false."
                  : "Dispatch acknowledged. Observe completion using get_agent_status/get_agent_activity or SDK/RPC subscriptions and wait APIs.",
            });
          },
          async getStatus(args) {
            const agent = (await client.fetchAgent(args.agentId as string))?.agent;
            if (!agent) throw new Error(`Agent ${args.agentId} not found`);
            return result({ status: agent.status, snapshot: agent });
          },
          async getActivity(args) {
            const agentId = args.agentId as string;
            const limit = args.limit as number | undefined;
            const timeline = await client.fetchAgentTimeline(agentId, {
              direction: "tail",
              limit: limit ?? 0,
            });
            const agent = (await client.fetchAgent(agentId))?.agent;
            if (!agent) throw new Error(`Agent ${agentId} not found`);
            return result({
              agentId,
              ...summarizeAgentActivity(
                timeline.entries.map((entry) => entry.item),
                limit,
              ),
              currentModeId: agent.currentModeId,
            });
          },
          async listAgents(args) {
            const { entries } = await client.fetchAgents({
              includeBackground: args.includeBackground === true,
              filter: { includeArchived: args.includeArchived === true },
            });
            return result({
              agents: selectAgentListItems(
                entries.map((entry) => entry.agent),
                {
                  cwd: (args.cwd as string | undefined)?.trim()
                    ? expandUserPath(args.cwd as string)
                    : undefined,
                  statuses: args.statuses as AgentSnapshotPayload["status"][] | undefined,
                  sinceHours: args.sinceHours as number | undefined,
                  limit: args.limit as number | undefined,
                },
              ),
            });
          },
          async listWorkspaces(args) {
            const { entries } = await client.fetchWorkspaces({
              includeBackground: args.includeBackground === true,
            });
            return result({ workspaces: entries.map(workspaceSummary) });
          },
          async createWorkspace(args) {
            const isolation = z.enum(["local", "worktree"]).parse(args.isolation);
            const path = z.string().min(1).parse(args.path);
            const response = await client.createWorkspace({
              source:
                isolation === "local"
                  ? { kind: "directory", path, projectId: args.projectId as string | undefined }
                  : {
                      kind: "worktree",
                      cwd: path,
                      projectId: args.projectId as string | undefined,
                      action:
                        args.mode === "checkout-branch" || args.mode === "checkout-pr"
                          ? "checkout"
                          : "branch-off",
                      baseBranch: args.baseBranch as string | undefined,
                      branchName: args.branchName as string | undefined,
                      refName: args.branch as string | undefined,
                      githubPrNumber: args.prNumber as number | undefined,
                      worktreeSlug: args.worktreeSlug as string | undefined,
                    },
              title: args.title as string | undefined,
              background: inheritWorkspaceBackground(
                args.background as boolean | undefined,
                input.caller(),
              ),
            });
            if (response.error || !response.workspace)
              throw new Error(response.error ?? "Workspace creation failed");
            return result(workspaceSummary(response.workspace));
          },
        }),
      );
    },
  };
}
function workspaceSummary(workspace: FetchWorkspacesEntry) {
  return {
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    cwd: workspace.workspaceDirectory,
    isolation: workspace.workspaceKind === "worktree" ? "worktree" : "local",
    kind: workspace.workspaceKind === "checkout" ? "local_checkout" : workspace.workspaceKind,
    title: workspace.title,
    background: workspace.background,
  };
}

function remoteObservation(client: DaemonClient): HostObservation {
  return {
    async observe(agentId, handler, signal, onError) {
      const observation = client.observeTimeline([agentId], { signal });
      const refresh = async (event?: AgentStreamEvent) => {
        let snapshot = (await client.fetchAgent(agentId))?.agent ?? null;
        let lastMessage: string | null = null;
        if (
          snapshot &&
          (snapshot.status === "idle" ||
            snapshot.status === "closed" ||
            snapshot.status === "error" ||
            snapshot.pendingPermissions.length > 0)
        ) {
          // A new turn may start between the snapshot and the current-response read.
          // Bound that wait and refresh state instead of attributing the old event to it.
          const current = await client.waitForFinish(agentId, 100);
          if (current.status === "timeout") {
            // Queued delivery can leave a closed/error snapshot visible before the new turn.
            // A timed-out wait has not established an outcome for that queued work.
            if (event?.type === "permission_resolved") handler(snapshot, event);
            return;
          }
          if (!current.final && current.error && current.error !== `Agent not found: ${agentId}`)
            throw new Error(current.error);
          snapshot = current.final;
          lastMessage = current.lastMessage;
        }
        handler(snapshot, event, lastMessage);
      };
      let updates = Promise.resolve();
      const unsubscribe = observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "agent_stream" || message.payload.agentId !== agentId) return;
          const event = message.payload.event;
          if (
            event.type === "permission_requested" ||
            event.type === "permission_resolved" ||
            event.type === "turn_started" ||
            event.type === "turn_completed" ||
            event.type === "turn_canceled" ||
            event.type === "turn_failed"
          )
            updates = updates.then(() => refresh(event)).catch(onError);
        },
        error: onError,
      });
      try {
        await observation.ready;
        await refresh();
      } catch (error) {
        unsubscribe();
        await observation.release();
        throw error;
      }
      return async () => {
        unsubscribe();
        await observation.release();
      };
    },
    wait: (agentId, signal, attentionRequest) => {
      const close = () => void client.close();
      signal.addEventListener("abort", close, { once: true });
      return (
        attentionRequest
          ? client.waitForAttentionOutcome({ agentId, attentionRequest })
          : client.waitForFinish(agentId, 0)
      )
        .then((outcome) => {
          if (!outcome.final && outcome.error && outcome.error !== `Agent not found: ${agentId}`)
            throw new Error(outcome.error);
          return outcome;
        })
        .finally(() => signal.removeEventListener("abort", close));
    },
  };
}

/** Shares routed status observation with daemon services independently of MCP execution. */
export function createHostObservationResolver(input: {
  serverId: string;
  local: HostObservation;
  hosts(): ToolHosts;
}) {
  return {
    async use<T>(
      serverId: string | undefined,
      action: (host: HostObservation) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      if (!serverId || serverId === input.serverId) return action(input.local);
      const hosts = input.hosts();
      async function classify(error: unknown): Promise<HostObservationError> {
        // This is the origin's authoritative registration directory, not a destination RPC error.
        const row = (await hosts.directory()).hosts.find((host) => host.serverId === serverId);
        if (!row) return new HostObservationError("removed", error);
        if (row.status === "connecting") return new HostObservationError("connecting", error);
        return new HostObservationError("unreachable", error);
      }
      async function fail(error: unknown): Promise<never> {
        throw await classify(error);
      }
      try {
        return await hosts.use(
          serverId,
          (client) => {
            const remote = remoteObservation(client);
            return action({
              wait: (agentId, lifetime, query) => remote.wait(agentId, lifetime, query).catch(fail),
              observe(agentId, handler, lifetime, onError) {
                async function report(error: unknown): Promise<void> {
                  try {
                    onError(await classify(error));
                  } catch (failure) {
                    onError(failure);
                  }
                }
                return remote.observe(agentId, handler, lifetime, report).catch(fail);
              },
            });
          },
          signal,
        );
      } catch (error) {
        if (error instanceof HostObservationError) throw error;
        return fail(error);
      }
    },
  };
}
