import { findMountedWindowStart } from "@/agent-stream/history-window";
import { z } from "zod";
import {
  AgentStatusSchema,
  AgentTimelineItemPayloadSchema,
  WorkspaceGitHubRuntimePayloadSchema,
} from "@getpaseo/protocol/messages";
import { AgentProviderSchema } from "@getpaseo/protocol/provider-manifest";
import type { PluginTimelineData } from "@getpaseo/plugin";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  type Agent,
  type AgentTimelineCursorState,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  isUnreconciledLocalUserMessage,
  type AgentToolCallData,
  type StreamItem,
} from "@/types/stream";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { clearLegacyReplicaCache } from "./legacy-cleanup";
import {
  REPLICA_SINGLETON_ROW_ID,
  type ReplicaRow,
  type ReplicaRowChanges,
  type ReplicaRowExpectation,
  type ReplicaRowKey,
  type ReplicaRowKind,
  type ReplicaRowStore,
} from "./row-store";

export type DirectoryReplicaMutation =
  | { kind: "agent"; type: "upsert"; id: string; value: Agent }
  | { kind: "agent"; type: "delete"; id: string }
  | { kind: "workspace"; type: "upsert"; id: string; value: WorkspaceDescriptor }
  | { kind: "workspace"; type: "delete"; id: string }
  | { kind: "project"; type: "upsert"; id: string; value: ProjectDescriptor }
  | { kind: "project"; type: "delete"; id: string };

export interface CachedDirectory {
  agents: Map<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;
  projects: Map<string, ProjectDescriptor>;
  checkpoint?: DirectoryCheckpoint;
}

export interface CachedWorkspace {
  workspace: WorkspaceDescriptor;
  project?: ProjectDescriptor;
}

export interface DirectoryCursor {
  generation: string;
  afterSeq: number;
}

export interface DirectoryCheckpoint {
  projects?: DirectoryCursor;
  workspaces?: DirectoryCursor;
  agents?: DirectoryCursor;
}

export interface CachedTimeline {
  agentId: string;
  items: StreamItem[];
  range: AgentTimelineCursorState | null;
  hasOlder: boolean;
}

const PERSIST_DELAY_MS = 1_000;
const MAX_TIMELINE_ITEMS = 50;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const IsoDateSchema = z.iso.datetime();
const TimelinePositionSchema = z.strictObject({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
});
const PluginTimelineDataSchema: z.ZodType<PluginTimelineData> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(PluginTimelineDataSchema),
    z.record(z.string(), PluginTimelineDataSchema),
  ]),
);

const TimelineItemBaseShape = {
  id: z.string(),
  timelineCursor: TimelinePositionSchema.optional(),
  // COMPAT(active-turn-membership): absent on caches written before turn membership.
  turnId: z.string().optional(),
  timestamp: IsoDateSchema,
};

const TodoEntrySchema = z.strictObject({
  text: z.string(),
  completed: z.boolean(),
  id: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  activeForm: z.string().optional(),
});

const TaskActivitySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("created"), count: z.number().int().nonnegative() }),
  z.strictObject({
    type: z.enum(["added", "started", "completed"]),
    task: z.string(),
  }),
]);

const StoredTimelineItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("user_message"),
    clientMessageId: z.string().optional(),
    messageId: z.string().optional(),
    text: z.string(),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("assistant_message"),
    messageId: z.string().optional(),
    text: z.string(),
    // Reject old caches containing display fragments; refetch the complete source text.
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("thought"),
    text: z.string(),
    status: z.enum(["loading", "ready"]),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("todo_list"),
    provider: AgentProviderSchema,
    items: z.array(TodoEntrySchema),
    activity: TaskActivitySchema,
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("notification"),
    sourceType: z.enum(["error", "notification"]),
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("compaction"),
    status: z.enum(["loading", "completed"]),
    trigger: z.enum(["auto", "manual"]).optional(),
    preTokens: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("tool_call"),
    provider: AgentProviderSchema,
    item: AgentTimelineItemPayloadSchema.refine((item) => item.type === "tool_call"),
  }),
  z.strictObject({
    ...TimelineItemBaseShape,
    kind: z.literal("plugin"),
    pluginId: z.string(),
    pluginItemId: z.string(),
    itemKind: z.string(),
    version: z.number().int().positive(),
    data: PluginTimelineDataSchema,
  }),
]);

const AgentCapabilitiesSchema = z.strictObject({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsSessionListing: z.boolean().optional(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
  supportsRewindConversation: z.boolean().optional(),
  supportsRewindFiles: z.boolean().optional(),
  supportsRewindBoth: z.boolean().optional(),
});

const StoredProjectCheckoutSchema = z.union([
  z.strictObject({
    cwd: z.string(),
    isGit: z.literal(false),
    currentBranch: z.null(),
    remoteUrl: z.null(),
    worktreeRoot: z.null(),
    isPaseoOwnedWorktree: z.literal(false),
    mainRepoRoot: z.null(),
  }),
  z.strictObject({
    cwd: z.string(),
    isGit: z.literal(true),
    currentBranch: z.string().nullable(),
    remoteUrl: z.string().nullable(),
    worktreeRoot: z.string(),
    isPaseoOwnedWorktree: z.literal(false),
    mainRepoRoot: z.string().nullable(),
  }),
  z.strictObject({
    cwd: z.string(),
    isGit: z.literal(true),
    currentBranch: z.string().nullable(),
    remoteUrl: z.string().nullable(),
    worktreeRoot: z.string(),
    isPaseoOwnedWorktree: z.literal(true),
    mainRepoRoot: z.string(),
  }),
]);

const StoredProjectPlacementSchema = z.strictObject({
  projectKey: z.string(),
  projectName: z.string(),
  workspaceName: z.string().nullable().optional(),
  checkout: StoredProjectCheckoutSchema,
});

const StoredAgentSnapshotSchema = z.strictObject({
  id: z.string(),
  provider: AgentProviderSchema,
  cwd: z.string(),
  workspaceId: z.string().optional(),
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable().optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  lastUserMessageAt: IsoDateSchema.nullable(),
  status: AgentStatusSchema,
  activeTurn: z
    .strictObject({
      turnId: z.string(),
      startedAt: IsoDateSchema.nullable(),
    })
    .nullable()
    .optional(),
  capabilities: AgentCapabilitiesSchema,
  currentModeId: z.string().nullable(),
  availableModes: z.array(z.never()).max(0),
  pendingPermissions: z.array(z.never()).max(0),
  persistence: z.null(),
  lastError: z.string().optional(),
  title: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  requiresAttention: z.boolean().optional(),
  attentionReason: z.enum(["finished", "error", "permission"]).nullable().optional(),
  attentionTimestamp: IsoDateSchema.nullable().optional(),
  archivedAt: IsoDateSchema.nullable().optional(),
});

const StoredAgentSchema = z.strictObject({
  snapshot: StoredAgentSnapshotSchema,
  turn: z
    .discriminatedUnion("phase", [
      z.strictObject({ phase: z.literal("idle") }),
      z.strictObject({
        phase: z.literal("open"),
        turnId: z.string().nullable(),
        startedAt: IsoDateSchema.nullable(),
      }),
    ])
    .optional(),
  projectPlacement: StoredProjectPlacementSchema.nullable(),
  lastActivityAt: IsoDateSchema,
});

const WorkspaceScriptSchema = z.strictObject({
  scriptName: z.string(),
  type: z.enum(["script", "service"]),
  hostname: z.string(),
  port: z.number().int().positive().nullable(),
  localProxyUrl: z.string().nullable().optional(),
  publicProxyUrl: z.string().nullable().optional(),
  proxyUrl: z.string().nullable(),
  lifecycle: z.enum(["running", "stopped"]),
  health: z.enum(["healthy", "unhealthy"]).nullable(),
  exitCode: z.number().nullable(),
  terminalId: z.string().nullable(),
});

const WorkspaceGitRuntimeSchema = z
  .strictObject({
    currentBranch: z.string().nullable().optional(),
    remoteUrl: z.string().nullable().optional(),
    isPaseoOwnedWorktree: z.boolean().optional(),
    isDirty: z.boolean().nullable().optional(),
    aheadBehind: z.strictObject({ ahead: z.number(), behind: z.number() }).nullable().optional(),
    aheadOfOrigin: z.number().nullable().optional(),
    behindOfOrigin: z.number().nullable().optional(),
  })
  .nullable()
  .optional();

const StoredWorkspaceSchema = z.strictObject({
  // Require both keys: a cursor without these values would preserve the wrong sort on reconnect.
  createdAt: IsoDateSchema.nullable(),
  lastUserMessageAt: IsoDateSchema.nullable(),
  id: z.string(),
  projectId: z.string(),
  projectDisplayName: z.string(),
  projectCustomName: z.string().nullable(),
  projectCustomIconRevision: z.string().nullable(),
  projectRootPath: z.string(),
  workspaceDirectory: z.string(),
  worktreeSlug: z.string().optional(),
  projectKind: z.enum(["git", "non_git", "directory"]),
  workspaceKind: z.enum(["directory", "local_checkout", "checkout", "worktree"]),
  // Legacy/provisional rows may omit this; a current workspace cursor requires it.
  background: z.boolean().optional(),
  name: z.string(),
  title: z.string().nullable(),
  pinnedAt: z.string().nullable(),
  // Optional because entries written before labels existed have none. A cached workspace that
  // dropped them painted its row without its chips and stayed that way: the directory cursor is
  // current on reconnect, so the daemon has nothing newer to send back.
  labels: z.array(z.string()).optional(),
  status: z.enum(["needs_input", "failed", "running", "attention", "done"]),
  statusEnteredAt: IsoDateSchema.nullable(),
  activityAt: z.null(),
  archivingAt: z.string().nullable(),
  diffStat: z.strictObject({ additions: z.number(), deletions: z.number() }).nullable(),
  scripts: z.array(WorkspaceScriptSchema),
  gitRuntime: WorkspaceGitRuntimeSchema,
  githubRuntime: WorkspaceGitHubRuntimePayloadSchema,
  forge: z.string().optional(),
});

const StoredProjectSchema = z.strictObject({
  projectId: z.string(),
  projectKey: z.string().optional(),
  projectDisplayName: z.string(),
  projectCustomName: z.string().nullable(),
  projectCustomIconRevision: z.string().nullable(),
  projectIconRevision: z.string().optional(),
  projectRootPath: z.string(),
  projectKind: z.enum(["git", "non_git", "directory"]),
});

const StoredTimelineSchema = z.strictObject({
  agentId: z.string(),
  items: z.array(StoredTimelineItemSchema),
  range: z
    .strictObject({
      epoch: z.string(),
      startSeq: z.number().int().nonnegative(),
      endSeq: z.number().int().nonnegative(),
    })
    .nullable(),
  hasOlder: z.boolean(),
});

type StoredAgent = z.infer<typeof StoredAgentSchema>;
type StoredTimeline = z.infer<typeof StoredTimelineSchema>;
type StoredTimelineItem = z.infer<typeof StoredTimelineItemSchema>;
type StoredToolCall = Extract<StoredTimelineItem, { kind: "tool_call" }>["item"];
type StoredWorkspace = z.infer<typeof StoredWorkspaceSchema>;
type StoredProject = z.infer<typeof StoredProjectSchema>;

interface ReplicaCacheOptions {
  maxBytes?: number;
  clearLegacyCache?: () => Promise<void>;
}

type StructuredReplicaUpsert =
  | { serverId: string; kind: "agent"; id: string; value: Agent }
  | { serverId: string; kind: "workspace"; id: string; value: WorkspaceDescriptor }
  | { serverId: string; kind: "project"; id: string; value: ProjectDescriptor }
  | { serverId: string; kind: "timeline"; id: string; value: CachedTimeline }
  | { serverId: string; kind: "checkpoint"; id: string; value: DirectoryCheckpoint };

const DirectoryCursorSchema = z.strictObject({
  generation: z.string(),
  afterSeq: z.number().int().nonnegative(),
});

const DirectoryCheckpointSchema = z.strictObject({
  projects: DirectoryCursorSchema.optional(),
  workspaces: DirectoryCursorSchema.optional(),
  agents: DirectoryCursorSchema.optional(),
});

// Earlier checkpoints could retain rows with a discarded baseline or missing background flags.
// Revalidate directory contents once without evicting cached rows or timelines.
const StoredDirectoryCheckpointSchema = z.strictObject({
  version: z.literal(2),
  cursors: DirectoryCheckpointSchema,
});

function serializeDirectoryCheckpoint(cursors: DirectoryCheckpoint) {
  return { version: 2 as const, cursors };
}

function deserializeDirectoryCheckpoint(payload: string): DirectoryCheckpoint {
  return parseStoredPayload(StoredDirectoryCheckpointSchema, payload).cursors;
}

function deserializeTimeline(stored: StoredTimeline | null): CachedTimeline | null {
  if (!stored) {
    return null;
  }
  return {
    agentId: stored.agentId,
    items: stored.items.map(deserializeTimelineItem),
    range: stored.range,
    hasOlder: stored.hasOlder,
  };
}

function timelineBase(item: StreamItem) {
  return {
    id: item.id,
    ...(item.timelineCursor ? { timelineCursor: item.timelineCursor } : {}),
    ...(item.turnId ? { turnId: item.turnId } : {}),
    timestamp: item.timestamp.toISOString(),
  };
}

function serializeAgentToolCall(data: AgentToolCallData): StoredToolCall {
  const base = {
    type: "tool_call" as const,
    callId: data.callId,
    name: data.name,
    detail: data.detail,
    ...(data.metadata ? { metadata: data.metadata } : {}),
    ...(data.agentMessage ? { agentMessage: data.agentMessage } : {}),
  };
  switch (data.status) {
    case "running":
    case "completed":
    case "canceled":
      return { ...base, status: data.status, error: null };
    case "failed":
      return { ...base, status: data.status, error: data.error };
  }
}

function serializeTimelineItem(item: StreamItem): StoredTimelineItem | null {
  const base = timelineBase(item);
  switch (item.kind) {
    case "user_message":
      return {
        ...base,
        kind: item.kind,
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
        ...(item.messageId ? { messageId: item.messageId } : {}),
        text: item.text,
      };
    case "assistant_message":
      return {
        ...base,
        kind: item.kind,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        text: item.text,
      };
    case "thought":
      return { ...base, kind: item.kind, text: item.text, status: item.status };
    case "todo_list":
      return {
        ...base,
        kind: item.kind,
        provider: item.provider,
        items: item.items,
        activity: item.activity,
      };
    case "notification":
      return {
        ...base,
        kind: item.kind,
        sourceType: item.sourceType,
        level: item.level,
        message: item.message,
      };
    case "compaction":
      return {
        ...base,
        kind: item.kind,
        status: item.status,
        ...(item.trigger ? { trigger: item.trigger } : {}),
        ...(item.preTokens !== undefined ? { preTokens: item.preTokens } : {}),
      };
    case "tool_call":
      if (item.payload.source !== "agent") return null;
      return {
        ...base,
        kind: item.kind,
        provider: item.payload.data.provider,
        item: serializeAgentToolCall(item.payload.data),
      };
    case "plugin":
      return {
        ...base,
        kind: item.kind,
        pluginId: item.pluginId,
        pluginItemId: item.pluginItemId,
        itemKind: item.itemKind,
        version: item.version,
        data: item.data,
      };
  }
}

function deserializeTimelineItem(item: StoredTimelineItem): StreamItem {
  if (item.kind === "plugin") {
    return {
      id: item.id,
      ...(item.timelineCursor ? { timelineCursor: item.timelineCursor } : {}),
      ...(item.turnId ? { turnId: item.turnId } : {}),
      timestamp: new Date(item.timestamp),
      kind: item.kind,
      pluginId: item.pluginId,
      pluginItemId: item.pluginItemId,
      itemKind: item.itemKind,
      version: item.version,
      data: item.data,
    };
  }
  return deserializeBuiltinTimelineItem(item);
}

function deserializeBuiltinTimelineItem(
  item: Exclude<StoredTimelineItem, { kind: "plugin" }>,
): StreamItem {
  const base = {
    id: item.id,
    ...(item.timelineCursor ? { timelineCursor: item.timelineCursor } : {}),
    ...(item.turnId ? { turnId: item.turnId } : {}),
    timestamp: new Date(item.timestamp),
  };
  switch (item.kind) {
    case "user_message":
      return {
        ...base,
        kind: item.kind,
        ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
        ...(item.messageId ? { messageId: item.messageId } : {}),
        text: item.text,
      };
    case "assistant_message":
      return {
        ...base,
        kind: item.kind,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        text: item.text,
      };
    case "thought":
      return { ...base, kind: item.kind, text: item.text, status: item.status };
    case "todo_list":
      return {
        ...base,
        kind: item.kind,
        provider: item.provider,
        items: item.items,
        activity: item.activity,
      };
    case "notification":
      return {
        ...base,
        kind: item.kind,
        sourceType: item.sourceType,
        level: item.level,
        message: item.message,
      };
    case "compaction":
      return {
        ...base,
        kind: item.kind,
        status: item.status,
        ...(item.trigger ? { trigger: item.trigger } : {}),
        ...(item.preTokens !== undefined ? { preTokens: item.preTokens } : {}),
      };
    case "tool_call": {
      const tool = item.item;
      if (tool.type !== "tool_call") {
        throw new Error("Stored tool call contains a non-tool timeline item");
      }
      return {
        ...base,
        kind: item.kind,
        payload: {
          source: "agent",
          data: {
            provider: item.provider,
            callId: tool.callId,
            name: tool.name,
            status: tool.status,
            error: tool.error,
            detail: tool.detail,
            ...(tool.metadata ? { metadata: tool.metadata } : {}),
            ...(tool.agentMessage ? { agentMessage: tool.agentMessage } : {}),
          },
        },
      };
    }
  }
}

function serializeProjectPlacement(agent: Agent): StoredAgent["projectPlacement"] {
  return agent.projectPlacement ?? null;
}

function serializeAgentTurn(agent: Agent): NonNullable<StoredAgent["turn"]> {
  if (agent.turn.phase === "idle") return { phase: "idle" };
  return {
    phase: "open",
    turnId: agent.turn.turnId,
    startedAt: agent.turn.startedAt?.toISOString() ?? null,
  };
}

function serializeAgent(agent: Agent): StoredAgent {
  const snapshot = {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
    model: agent.model,
    thinkingOptionId: agent.thinkingOptionId ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt?.toISOString() ?? null,
    status: agent.status,
    ...(agent.turn.phase === "open" && agent.turn.turnId
      ? {
          activeTurn: {
            turnId: agent.turn.turnId,
            startedAt: agent.turn.startedAt?.toISOString() ?? null,
          },
        }
      : {}),
    capabilities: {
      supportsStreaming: agent.capabilities.supportsStreaming,
      supportsSessionPersistence: agent.capabilities.supportsSessionPersistence,
      ...(agent.capabilities.supportsSessionListing !== undefined
        ? { supportsSessionListing: agent.capabilities.supportsSessionListing }
        : {}),
      supportsDynamicModes: agent.capabilities.supportsDynamicModes,
      supportsMcpServers: agent.capabilities.supportsMcpServers,
      supportsReasoningStream: agent.capabilities.supportsReasoningStream,
      supportsToolInvocations: agent.capabilities.supportsToolInvocations,
      ...(agent.capabilities.supportsRewindConversation !== undefined
        ? { supportsRewindConversation: agent.capabilities.supportsRewindConversation }
        : {}),
      ...(agent.capabilities.supportsRewindFiles !== undefined
        ? { supportsRewindFiles: agent.capabilities.supportsRewindFiles }
        : {}),
      ...(agent.capabilities.supportsRewindBoth !== undefined
        ? { supportsRewindBoth: agent.capabilities.supportsRewindBoth }
        : {}),
    },
    currentModeId: agent.currentModeId,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    ...(agent.lastError ? { lastError: agent.lastError } : {}),
    title: agent.title,
    labels: agent.labels,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    attentionTimestamp: agent.attentionTimestamp?.toISOString() ?? null,
    archivedAt: agent.archivedAt?.toISOString() ?? null,
  };
  return {
    snapshot,
    turn: serializeAgentTurn(agent),
    projectPlacement: serializeProjectPlacement(agent),
    lastActivityAt: agent.lastActivityAt.toISOString(),
  };
}

function deserializeAgent(serverId: string, stored: StoredAgent): Agent {
  const normalized = normalizeAgentSnapshot(stored.snapshot, serverId);
  let turn = normalized.turn;
  if (stored.turn?.phase === "idle") turn = { phase: "idle", cancellationRequestId: null };
  if (stored.turn?.phase === "open") {
    turn = {
      phase: "open",
      turnId: stored.turn.turnId,
      startedAt: stored.turn.startedAt ? new Date(stored.turn.startedAt) : null,
      cancellationRequestId: null,
    };
  }
  return {
    ...normalized,
    turn,
    lastActivityAt: new Date(stored.lastActivityAt),
    projectPlacement: stored.projectPlacement,
  };
}

function restoreWorkspace(stored: StoredWorkspace): WorkspaceDescriptor {
  return normalizeWorkspaceDescriptor({ ...stored, createdAt: stored.createdAt ?? undefined });
}

function serializeWorkspace(workspace: WorkspaceDescriptor): StoredWorkspace {
  return {
    createdAt: workspace.createdAt?.toISOString() ?? null,
    lastUserMessageAt: workspace.lastUserMessageAt?.toISOString() ?? null,
    id: workspace.id,
    projectId: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
    projectCustomName: workspace.projectCustomName ?? null,
    projectCustomIconRevision: workspace.projectCustomIconRevision ?? null,
    projectRootPath: workspace.projectRootPath,
    workspaceDirectory: workspace.workspaceDirectory,
    worktreeSlug: workspace.worktreeSlug,
    projectKind: workspace.projectKind,
    workspaceKind: workspace.workspaceKind,
    background: workspace.background ?? false,
    name: workspace.name,
    title: workspace.title ?? null,
    pinnedAt: workspace.pinnedAt ?? null,
    labels: workspace.labels,
    status: workspace.status,
    statusEnteredAt: workspace.statusEnteredAt?.toISOString() ?? null,
    activityAt: null,
    archivingAt: workspace.archivingAt,
    diffStat: workspace.diffStat,
    scripts: workspace.scripts.map((script) => ({
      scriptName: script.scriptName,
      type: script.type,
      hostname: script.hostname,
      port: script.port,
      ...(script.localProxyUrl !== undefined ? { localProxyUrl: script.localProxyUrl } : {}),
      ...(script.publicProxyUrl !== undefined ? { publicProxyUrl: script.publicProxyUrl } : {}),
      proxyUrl: script.proxyUrl,
      lifecycle: script.lifecycle,
      health: script.health,
      exitCode: script.exitCode,
      terminalId: script.terminalId,
    })),
    gitRuntime: workspace.gitRuntime,
    githubRuntime: workspace.githubRuntime,
    forge: workspace.forge,
  };
}

function serializeProject(project: ProjectDescriptor): StoredProject {
  return {
    projectId: project.projectId,
    ...(project.projectKey ? { projectKey: project.projectKey } : {}),
    projectDisplayName: project.projectDisplayName,
    projectCustomName: project.projectCustomName,
    projectCustomIconRevision: project.projectCustomIconRevision ?? null,
    projectIconRevision: project.projectIconRevision,
    projectRootPath: project.projectRootPath,
    projectKind: project.projectKind,
  };
}

function isTimelineItemStoredLosslessly(item: StreamItem): boolean {
  switch (item.kind) {
    case "user_message":
      return (item.images?.length ?? 0) === 0 && (item.attachments?.length ?? 0) === 0;
    case "tool_call":
      return item.payload.source === "agent";
    default:
      return true;
  }
}

function serializeTimeline(timeline: CachedTimeline): StoredTimeline | null {
  const canonicalItems = timeline.items.filter(
    (item) => item.kind !== "user_message" || !isUnreconciledLocalUserMessage(item),
  );
  const start = findMountedWindowStart({
    items: canonicalItems,
    minMountedCount: MAX_TIMELINE_ITEMS,
  });
  const items = canonicalItems
    .slice(start)
    .map(serializeTimelineItem)
    .filter((item) => item !== null);
  const range = timeline.range;
  const canPersistCoverage =
    range !== null &&
    range.retainedRanges === undefined &&
    canonicalItems.length <= MAX_TIMELINE_ITEMS &&
    items.length === canonicalItems.length &&
    canonicalItems.every(
      (item) =>
        isTimelineItemStoredLosslessly(item) &&
        item.timelineCursor?.epoch === range.epoch &&
        item.timelineCursor.seq >= range.startSeq &&
        item.timelineCursor.seq <= range.endSeq,
    ) &&
    canonicalItems.some((item) => item.timelineCursor?.seq === range.endSeq);
  return {
    agentId: timeline.agentId,
    items,
    range: canPersistCoverage
      ? { epoch: range.epoch, startSeq: range.startSeq, endSeq: range.endSeq }
      : null,
    hasOlder: canPersistCoverage ? timeline.hasOlder : false,
  };
}

function rowKey(key: Pick<ReplicaRowKey, "kind" | "id">): string {
  return `${key.kind}\u0000${key.id}`;
}

function pendingRowKey(key: ReplicaRowKey): string {
  return `${key.serverId}\u0000${rowKey(key)}`;
}

// Budget accounting runs over every stored row of a touched host on each persist. Rows are
// immutable once stored, so their size is computed once. The count itself avoids the JS Buffer
// polyfill, which materialises the whole byte array just to measure it.
const rowBytesCache = new WeakMap<ReplicaRow, number>();

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function rowBytes(row: ReplicaRow): number {
  let bytes = rowBytesCache.get(row);
  if (bytes === undefined) {
    bytes = utf8ByteLength(row.payload);
    rowBytesCache.set(row, bytes);
  }
  return bytes;
}

function parseJsonPayload(payload: string): unknown {
  return JSON.parse(payload);
}

function parseStoredPayload<Value>(schema: z.ZodType<Value>, payload: string): Value {
  const parsed = schema.safeParse(parseJsonPayload(payload));
  if (!parsed.success) throw new Error("Invalid replica row payload");
  return parsed.data;
}

interface DirectoryReadAccumulator {
  agents: Map<string, Agent>;
  workspaces: Map<string, WorkspaceDescriptor>;
  projects: Map<string, ProjectDescriptor>;
  checkpoint?: DirectoryCheckpoint;
}

interface PendingReplicaChanges {
  upserts: StructuredReplicaUpsert[];
  deletes: ReplicaRowKey[];
  baselines: Set<string>;
}

/**
 * Applies one stored directory row to the accumulator, throwing when the row is invalid.
 *
 * Workspace rows are validated against `result.checkpoint`, so callers apply the checkpoint row
 * before any entity row (see `scanDirectoryRows`).
 */
function applyDirectoryRow(
  serverId: string,
  row: ReplicaRow,
  result: DirectoryReadAccumulator,
): void {
  switch (row.kind) {
    case "agent": {
      const stored = parseStoredPayload(StoredAgentSchema, row.payload);
      if (stored.snapshot.id !== row.id) throw new Error("Replica agent row id mismatch");
      result.agents.set(row.id, deserializeAgent(serverId, stored));
      return;
    }
    case "workspace": {
      result.workspaces.set(row.id, parseWorkspaceRow(row, result.checkpoint));
      return;
    }
    case "project": {
      const stored = parseStoredPayload(StoredProjectSchema, row.payload);
      if (stored.projectId !== row.id) throw new Error("Replica project row id mismatch");
      result.projects.set(row.id, normalizeProjectDescriptor(stored));
      return;
    }
    case "checkpoint":
      if (row.id !== REPLICA_SINGLETON_ROW_ID) {
        throw new Error("Replica checkpoint row id mismatch");
      }
      result.checkpoint = deserializeDirectoryCheckpoint(row.payload);
      return;
    default:
      return;
  }
}

function directoryEntityForRow(row: ReplicaRow): keyof DirectoryCheckpoint | undefined {
  if (row.kind === "agent") return "agents";
  if (row.kind === "workspace") return "workspaces";
  if (row.kind === "project") return "projects";
  return undefined;
}

/**
 * Parses a cached workspace row against the checkpoint read with it.
 *
 * Rows written before background visibility was cached have no `background` flag. Such a row is
 * acceptable provisionally while no workspace cursor vouches for it. A current workspace cursor
 * claims a complete baseline, so under that cursor a missing flag makes the row invalid and the
 * daemon must resend it.
 *
 * @param checkpoint The checkpoint cursors read in the same scope, if any.
 * @throws When the payload is invalid, its id does not match the row, or the flag is missing
 *   under a current workspace cursor.
 */
function parseWorkspaceRow(
  row: ReplicaRow,
  checkpoint: DirectoryCheckpoint | undefined,
): WorkspaceDescriptor {
  const stored = parseStoredPayload(StoredWorkspaceSchema, row.payload);
  if (stored.id !== row.id) throw new Error("Replica workspace row id mismatch");
  if (stored.background === undefined && checkpoint?.workspaces) {
    throw new Error("Current workspace baseline is missing background visibility");
  }
  return restoreWorkspace(stored);
}

/** One workspace row validated against the checkpoint read with it. */
interface WorkspaceSnapshot {
  /** The workspace, or undefined when its row is invalid. */
  workspace: WorkspaceDescriptor | undefined;
  /** The checkpoint to keep; without its workspace cursor when the workspace row is invalid. */
  checkpoint: DirectoryCheckpoint | undefined;
  /** Rows the repair deletes: an unreadable checkpoint and an invalid workspace row. */
  invalidRows: ReplicaRow[];
}

/**
 * Validates a single workspace read: the checkpoint first, then the workspace row against it.
 * An invalid workspace row voids only the workspace cursor; the other cursors stay trusted.
 */
function validateWorkspaceSnapshot(
  workspaceRow: ReplicaRow,
  checkpointRow: ReplicaRow | undefined,
): WorkspaceSnapshot {
  let checkpoint: DirectoryCheckpoint | undefined;
  const invalidRows: ReplicaRow[] = [];
  if (checkpointRow) {
    try {
      checkpoint = deserializeDirectoryCheckpoint(checkpointRow.payload);
    } catch {
      invalidRows.push(checkpointRow);
    }
  }
  let workspace: WorkspaceDescriptor | undefined;
  try {
    workspace = parseWorkspaceRow(workspaceRow, checkpoint);
  } catch {
    invalidRows.push(workspaceRow);
    if (checkpoint) {
      checkpoint = { ...checkpoint };
      delete checkpoint.workspaces;
    }
  }
  return { workspace, checkpoint, invalidRows };
}

function emptyDirectory(): DirectoryReadAccumulator {
  return { agents: new Map(), workspaces: new Map(), projects: new Map() };
}

/** The result of applying one directory read's rows. */
interface DirectoryRowScan {
  /** Every valid row, with the checkpoint stripped of cursors the invalid rows voided. */
  result: DirectoryReadAccumulator;
  invalidRows: ReplicaRow[];
  /** The checkpoint row as read, or undefined when the read found none. */
  checkpointRow: ReplicaRow | undefined;
}

/**
 * Applies a directory read's rows, checkpoint rows first. Workspace validity depends on the
 * checkpoint read in the same snapshot, so the order must not follow storage enumeration.
 */
function scanDirectoryRows(serverId: string, rows: readonly ReplicaRow[]): DirectoryRowScan {
  const result = emptyDirectory();
  const invalidEntities = new Set<keyof DirectoryCheckpoint>();
  const invalidRows: ReplicaRow[] = [];
  for (const row of rows.filter((candidate) => candidate.kind === "checkpoint")) {
    try {
      applyDirectoryRow(serverId, row, result);
    } catch {
      invalidRows.push(row);
    }
  }
  for (const row of rows) {
    if (row.kind === "checkpoint") {
      continue;
    }
    try {
      applyDirectoryRow(serverId, row, result);
    } catch {
      const entity = directoryEntityForRow(row);
      if (entity) invalidEntities.add(entity);
      invalidRows.push(row);
    }
  }
  if (result.checkpoint && invalidEntities.size) {
    result.checkpoint = { ...result.checkpoint };
    for (const entity of invalidEntities) delete result.checkpoint[entity];
  }
  const checkpointRow = rows.find(
    (row) => row.kind === "checkpoint" && row.id === REPLICA_SINGLETON_ROW_ID,
  );
  return { result, invalidRows, checkpointRow };
}

/**
 * Tracks the workspace cursor a workspace read observed. That read depends on the checkpoint only
 * through its workspace cursor, so checkpoint writes that leave the cursor unchanged (an agent or
 * project cursor advancing) do not invalidate it.
 */
interface WorkspaceAuthority {
  /** Projection of the checkpoint the read observed; undefined until storage was read. */
  observed?: string;
  /** Projections of checkpoint writes accepted while the read was in flight. */
  changes: Set<string>;
}

interface ReplicaRead {
  serverId: string;
  kinds: readonly ReplicaRowKind[];
  ids?: readonly string[];
  invalidated: boolean;
  /** When set, the scope matches these exact rows instead of the kinds and ids cross product. */
  keys?: Array<Pick<ReplicaRowKey, "kind" | "id">>;
  workspaceAuthority?: WorkspaceAuthority;
}

/**
 * Returned by a scoped read operation when its scope was invalidated (a concurrent write, host
 * change or lost repair comparison). `withReadScope` then reruns the operation under a fresh scope.
 */
const RETRY_REPLICA_READ = Symbol("retry replica read");

/**
 * Bounds how many fresh scopes one read may use. Each retry means another write or repair won the
 * race; exhausting the bound answers as a cache miss, and the daemon supplies the data instead.
 */
const MAX_SCOPED_READ_ATTEMPTS = 8;

/** The parts of a read scope a caller chooses. */
interface ReadScopeRequest {
  serverId: string;
  kinds: readonly ReplicaRowKind[];
  ids?: readonly string[];
  /**
   * Scopes the read to one workspace row and the checkpoint by key, and tracks the checkpoint's
   * workspace cursor so unrelated checkpoint writes do not invalidate the read.
   */
  workspaceAuthority?: { workspaceId: string };
}

/**
 * How a read-time repair ended: committed, lost its comparison to another context (the read must
 * retry), or failed in storage (the read answers as a miss rather than retrying a failing write).
 */
type RepairOutcome = "repaired" | "retry" | "failed";

async function repairOutcome(repair: () => Promise<boolean>): Promise<RepairOutcome> {
  try {
    return (await repair()) ? "repaired" : "retry";
  } catch {
    return "failed";
  }
}

function parseAgentRow(serverId: string, row: ReplicaRow): Agent {
  const stored = parseStoredPayload(StoredAgentSchema, row.payload);
  if (stored.snapshot.id !== row.id) throw new Error("Replica agent row id mismatch");
  return deserializeAgent(serverId, stored);
}

function parseProjectRow(row: ReplicaRow): ProjectDescriptor {
  const stored = parseStoredPayload(StoredProjectSchema, row.payload);
  if (stored.projectId !== row.id) throw new Error("Replica project row id mismatch");
  return normalizeProjectDescriptor(stored);
}

/** @returns undefined for a valid timeline stored under another agent id. */
function parseTimelineRow(agentId: string, row: ReplicaRow): CachedTimeline | undefined {
  const stored = parseStoredPayload(StoredTimelineSchema, row.payload);
  if (stored.agentId !== agentId) return undefined;
  return deserializeTimeline(stored) ?? undefined;
}

/**
 * Projects a stored checkpoint payload to the part a workspace read depends on. A readable
 * checkpoint projects to `["current", workspaces cursor or null]`; a missing or unreadable one
 * is `"provisional"`, because no cursor vouches for the cached workspace rows. Reads compare
 * projections by string equality.
 */
function workspaceAuthorityProjection(payload: string | undefined): string {
  if (typeof payload !== "string") return "provisional";
  try {
    return JSON.stringify(["current", deserializeDirectoryCheckpoint(payload).workspaces ?? null]);
  } catch {
    return "provisional";
  }
}

/** Whether a row belongs to a scope: by exact key when the scope has keys, else by kind and id. */
function matchesReplicaRead(read: ReplicaRead, row: ReplicaRowKey): boolean {
  return (
    read.serverId === row.serverId &&
    (read.keys
      ? read.keys.some((key) => key.kind === row.kind && key.id === row.id)
      : read.kinds.includes(row.kind) && (!read.ids || read.ids.includes(row.id)))
  );
}

/**
 * Records the workspace authority a read observed in storage, and invalidates the read when a
 * checkpoint write accepted while it was in flight projects differently.
 */
function bindWorkspaceAuthority(read: ReplicaRead, rows: ReplicaRow[]): void {
  const authority = read.workspaceAuthority;
  if (!authority) return;
  const checkpoint = rows.find(
    (row) => row.kind === "checkpoint" && row.id === REPLICA_SINGLETON_ROW_ID,
  );
  authority.observed = workspaceAuthorityProjection(checkpoint?.payload);
  if ([...authority.changes].some((value) => value !== authority.observed)) read.invalidated = true;
}

/**
 * The host a queued repair belongs to. Host removal cancels it and a rename moves it to the new
 * id, so a repair that commits late never fences cursors for a host that was removed, re-added
 * or replaced while it waited.
 */
interface RepairNamespace {
  serverId: string;
  incarnation: symbol | undefined;
  cancelled: boolean;
}

/** What one read-time repair deletes and rewrites, and the raw rows it was planned from. */
interface RepairPlan {
  serverId: string;
  /** Rows to delete: invalid entity rows and, when unreadable, the checkpoint row itself. */
  invalidRows: ReplicaRow[];
  /**
   * Cursors to write back, already without those the invalid rows voided. Omitted when the
   * checkpoint row is left as it is.
   */
  checkpoint?: DirectoryCheckpoint;
  /** The checkpoint row as read, or undefined when the read found none. */
  checkpointRow?: ReplicaRow;
  /** The read scope the repair belongs to; the repair is abandoned once it can no longer publish. */
  revision: ReplicaRead;
  /** Raw rows the plan depends on, compared by payload before applying. Defaults to invalidRows. */
  observedRows?: readonly ReplicaRow[];
  /**
   * `as-read` also compares the checkpoint row, including its absence. `unguarded` is for rows
   * with no directory cursor (timelines), whose repair does not depend on the checkpoint.
   */
  checkpointGuard: "as-read" | "unguarded";
}

/** Deletes the invalid rows and, when the checkpoint stays readable, rewrites its cursors. */
function planRepairChanges(plan: RepairPlan): ReplicaRowChanges {
  const { serverId, invalidRows, checkpoint } = plan;
  const checkpointWasInvalid = invalidRows.some(
    (row) => row.kind === "checkpoint" && row.id === REPLICA_SINGLETON_ROW_ID,
  );
  return {
    deletes: invalidRows,
    upserts:
      checkpoint !== undefined && !checkpointWasInvalid
      ? [
          {
            serverId,
            kind: "checkpoint",
            id: REPLICA_SINGLETON_ROW_ID,
            payload: JSON.stringify(serializeDirectoryCheckpoint(checkpoint)),
          },
        ]
      : [],
  };
}

/**
 * The compare-and-apply expectations for a repair: every observed row by payload and, unless
 * unguarded, the checkpoint as read. Comparing in the same storage transaction keeps a repair
 * planned in one browser context from deleting a newer baseline written by another.
 *
 * @throws When an observation has no string payload; such a row cannot be compared.
 */
function repairExpectations(plan: RepairPlan): ReplicaRowExpectation[] {
  const { serverId, checkpointRow } = plan;
  const observedRows = plan.observedRows ?? plan.invalidRows;
  const observations = [...observedRows, ...(checkpointRow ? [checkpointRow] : [])];
  if (observations.some((row) => typeof row.payload !== "string")) {
    throw new Error("Replica repair requires string payload observations");
  }
  const expected = new Map<string, ReplicaRowExpectation>();
  for (const row of observedRows) {
    expected.set(rowKey(row), row);
  }
  if (plan.checkpointGuard === "as-read") {
    const key = { serverId, kind: "checkpoint" as const, id: REPLICA_SINGLETON_ROW_ID };
    expected.set(rowKey(key), { ...key, payload: checkpointRow ? checkpointRow.payload : null });
  }
  return [...expected.values()];
}

export class ReplicaCache {
  private readonly activeServerIds = new Set<string>();
  /**
   * A fresh symbol each time a host id is added, removed or renamed. Work captured under an older
   * symbol belongs to an earlier registration of that id and must not touch the current fences.
   */
  private readonly hostIncarnations = new Map<string, symbol>();
  /** Repairs queued on the write queue, so host removal and renaming can retarget them. */
  private readonly repairNamespaces = new Set<RepairNamespace>();
  /** Entity cursors a repair invalidated; only a persisted complete baseline restores them. */
  private readonly invalidDirectoryCursors = new Map<string, Set<keyof DirectoryCheckpoint>>();
  private readonly activeReads = new Set<ReplicaRead>();
  private readonly storedRows = new Map<string, Map<string, ReplicaRow>>();
  private readonly hostBytes = new Map<string, number>();
  private readonly hostWriteOrder = new Map<string, true>();
  private pendingUpserts = new Map<string, StructuredReplicaUpsert>();
  private pendingDeletes = new Map<string, ReplicaRowKey>();
  private pendingBaselines = new Set<string>();
  private readonly invalidatedHosts = new Set<string>();
  private readonly maxBytes: number;
  private totalBytes = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private preparePromise: Promise<void> | null = null;
  private storedIndexPromise: Promise<void> | null = null;

  constructor(
    private readonly rowStore: ReplicaRowStore,
    options: ReplicaCacheOptions = {},
  ) {
    this.maxBytes = Math.max(options.maxBytes ?? MAX_CACHE_BYTES, 0);
    this.clearLegacyCache = options.clearLegacyCache ?? clearLegacyReplicaCache;
  }

  private readonly clearLegacyCache: () => Promise<void>;

  async readAgent(serverId: string, agentId: string): Promise<Agent | undefined> {
    return this.withReadScope<Agent>({ serverId, kinds: ["agent"], ids: [agentId] }, (scope) =>
      this.readScopedRow(scope, "agent", agentId, (row) => parseAgentRow(serverId, row)),
    );
  }

  async readWorkspace(serverId: string, workspaceId: string): Promise<CachedWorkspace | undefined> {
    return this.withReadScope<CachedWorkspace>(
      {
        serverId,
        kinds: ["workspace", "checkpoint", "project"],
        ids: [workspaceId, REPLICA_SINGLETON_ROW_ID],
        workspaceAuthority: { workspaceId },
      },
      async (revision) => {
        const rows = await this.readRows({
          scope: revision,
          kinds: ["workspace", "checkpoint"],
          ids: [workspaceId, REPLICA_SINGLETON_ROW_ID],
        });
        if (!rows) return undefined;
        if (!this.canPublishRead(revision)) return RETRY_REPLICA_READ;
        const workspaceRow = rows.find((row) => row.kind === "workspace" && row.id === workspaceId);
        if (!workspaceRow) return undefined;
        const checkpointRow = rows.find(
          (row) => row.kind === "checkpoint" && row.id === REPLICA_SINGLETON_ROW_ID,
        );
        const { workspace, checkpoint, invalidRows } = validateWorkspaceSnapshot(
          workspaceRow,
          checkpointRow,
        );
        if (invalidRows.length) {
          const outcome = await repairOutcome(() =>
            this.repairInvalidDirectoryRows({
              serverId,
              invalidRows,
              checkpoint,
              checkpointRow,
              revision,
              observedRows: [workspaceRow, ...invalidRows],
              checkpointGuard: "as-read",
            }),
          );
          if (outcome === "retry") return RETRY_REPLICA_READ;
          if (outcome === "failed") return undefined;
        }
        if (!workspace) return undefined;

        // The project row joins the scope by key, so only a write to this project invalidates it.
        revision.keys?.push({ kind: "project", id: workspace.projectId });
        const projectRows = await this.readRows({
          scope: revision,
          kinds: ["project"],
          ids: [workspace.projectId],
        });
        if (!projectRows) return undefined;
        const projectRow = projectRows[0];
        if (!this.canPublishRead(revision)) return RETRY_REPLICA_READ;
        let project: ProjectDescriptor | undefined;
        if (projectRow) {
          try {
            project = parseProjectRow(projectRow);
          } catch {
            const outcome = await repairOutcome(() => this.deleteInvalidRow(projectRow, revision));
            if (outcome === "retry") return RETRY_REPLICA_READ;
            if (outcome === "failed") return undefined;
          }
        }
        if (!this.canPublishRead(revision)) return RETRY_REPLICA_READ;
        return { workspace, ...(project ? { project } : {}) };
      },
    );
  }

  /** Exhausted retries answer as an empty directory, the same as a cache miss. */
  async readDirectory(serverId: string): Promise<CachedDirectory> {
    const directoryKinds: ReplicaRowKind[] = ["agent", "workspace", "project", "checkpoint"];
    const directory = await this.withReadScope<CachedDirectory>(
      { serverId, kinds: directoryKinds },
      async (revision) => {
        const rows = await this.readRows({ scope: revision, kinds: directoryKinds });
        if (!rows) return undefined;
        if (!this.canPublishRead(revision)) return RETRY_REPLICA_READ;
        const { result, invalidRows, checkpointRow } = scanDirectoryRows(serverId, rows);
        if (invalidRows.length) {
          const outcome = await repairOutcome(() =>
            this.repairInvalidDirectoryRows({
              serverId,
              invalidRows,
              checkpoint: result.checkpoint,
              checkpointRow,
              revision,
              checkpointGuard: "as-read",
            }),
          );
          if (outcome === "retry") return RETRY_REPLICA_READ;
          if (outcome === "failed") return undefined;
        }
        if (!this.canPublishRead(revision)) return RETRY_REPLICA_READ;
        return result;
      },
    );
    return directory ?? emptyDirectory();
  }

  async readTimeline(serverId: string, agentId: string): Promise<CachedTimeline | undefined> {
    return this.withReadScope<CachedTimeline>(
      { serverId, kinds: ["timeline"], ids: [agentId] },
      (scope) => this.readScopedRow(scope, "timeline", agentId, (row) => parseTimelineRow(agentId, row)),
    );
  }

  /**
   * Reads and parses one row under the scope. An invalid row is deleted and answers as a miss.
   * A repair that lost its comparison to another context retries; one that failed in storage is
   * a miss, so a failing store cannot spin the read.
   *
   * @param parse Returns the value, or undefined for a valid row that does not answer this read;
   *   throws for an invalid row.
   */
  private async readScopedRow<Value>(
    scope: ReplicaRead,
    kind: ReplicaRowKind,
    id: string,
    parse: (row: ReplicaRow) => Value | undefined,
  ): Promise<Value | undefined | typeof RETRY_REPLICA_READ> {
    const rows = await this.readRows({ scope, kinds: [kind], ids: [id] });
    if (!rows) return undefined;
    const row = rows[0];
    if (!this.canPublishRead(scope)) return RETRY_REPLICA_READ;
    if (!row) return undefined;
    try {
      return parse(row);
    } catch {
      const outcome = await repairOutcome(() => this.deleteInvalidRow(row, scope));
      return outcome === "retry" ? RETRY_REPLICA_READ : undefined;
    }
  }

  /**
   * Runs a read operation under a registered scope, so writes, deletions and host changes that
   * touch the scope invalidate it while it is in flight. An operation that returns
   * `RETRY_REPLICA_READ` reruns under a fresh scope, up to `MAX_SCOPED_READ_ATTEMPTS` times.
   *
   * @returns The operation's result, or undefined when the host is inactive or retries ran out.
   */
  private async withReadScope<Result>(
    request: ReadScopeRequest,
    operation: (read: ReplicaRead) => Promise<Result | undefined | typeof RETRY_REPLICA_READ>,
  ): Promise<Result | undefined> {
    const { serverId, kinds, ids, workspaceAuthority } = request;
    for (
      let attempt = 0;
      attempt < MAX_SCOPED_READ_ATTEMPTS && this.activeServerIds.has(serverId);
      attempt += 1
    ) {
      const read: ReplicaRead = {
        serverId,
        kinds,
        ids,
        invalidated: false,
        ...(workspaceAuthority
          ? {
              keys: [
                { kind: "workspace", id: workspaceAuthority.workspaceId },
                { kind: "checkpoint", id: REPLICA_SINGLETON_ROW_ID },
              ],
              workspaceAuthority: { changes: new Set<string>() },
            }
          : {}),
      };
      this.activeReads.add(read);
      try {
        const result = await operation(read);
        if (result === RETRY_REPLICA_READ) {
          continue;
        }
        return result;
      } finally {
        this.activeReads.delete(read);
      }
    }
    return undefined;
  }

  /** Whether a scope may still publish: its host is active and nothing it read has changed. */
  private canPublishRead(read: ReplicaRead): boolean {
    return (
      this.activeServerIds.has(read.serverId) &&
      !read.invalidated &&
      !this.hasPendingReadChanges(read)
    );
  }

  /**
   * Reads rows from storage for an active scope, after accepted pending writes reach storage.
   *
   * @returns The rows; an empty list when the host is inactive or the scope was invalidated
   *   (callers then see `canPublishRead` fail and retry); undefined when storage failed or
   *   pending writes for this host could not be persisted.
   */
  private async readRows(input: {
    scope: ReplicaRead;
    kinds: readonly ReplicaRowKind[];
    ids?: readonly string[];
  }): Promise<ReplicaRow[] | undefined> {
    const { scope, kinds, ids } = input;
    const { serverId } = scope;
    if (!this.activeServerIds.has(serverId)) return [];
    try {
      await this.prepareStore();
      if (!this.activeServerIds.has(serverId)) return [];
      if (!(await this.syncPending()) && this.hasPendingHostChanges(serverId)) return undefined;
      if (scope.invalidated || this.hasPendingReadChanges(scope)) return [];
      const rows = await this.rowStore.read(serverId, kinds, ids);
      if (kinds.includes("checkpoint")) bindWorkspaceAuthority(scope, rows);
      return this.canPublishRead(scope) ? rows : [];
    } catch {
      return undefined;
    }
  }

  /**
   * Deletes one invalid row. A directory entity row also drops its entity cursor, so a later
   * launch cannot trust a checkpoint for a partial baseline.
   *
   * @returns false when the scope was invalidated or the stored rows changed since they were
   *   read; the caller retries. Rejects when storage fails.
   */
  private async deleteInvalidRow(row: ReplicaRow, revision: ReplicaRead): Promise<boolean> {
    if (!this.canPublishRead(revision)) return false;
    const entity = directoryEntityForRow(row);
    if (!entity) {
      return this.repairInvalidDirectoryRows({
        serverId: row.serverId,
        invalidRows: [row],
        revision,
        checkpointGuard: "unguarded",
      });
    }
    // The repair now also depends on the checkpoint row. Widen the scope to it so a concurrent
    // checkpoint write invalidates this read instead of letting a stale repair publish.
    revision.workspaceAuthority = undefined;
    revision.kinds = [...new Set([...revision.kinds, "checkpoint" as const])];
    revision.keys?.push({ kind: "checkpoint", id: REPLICA_SINGLETON_ROW_ID });
    revision.ids = undefined;
    // Reread the row with the checkpoint. This only happens for invalid data, and the repair
    // compares both raw rows, so a row another context replaced in between is never deleted.
    const rows = await this.rowStore.read(
      row.serverId,
      [row.kind, "checkpoint"],
      [row.id, REPLICA_SINGLETON_ROW_ID],
    );
    if (!this.canPublishRead(revision)) return false;
    const current = rows.find(
      (candidate) => candidate.kind === row.kind && candidate.id === row.id,
    );
    if (current?.payload !== row.payload) return false;
    const checkpointRow = rows.find(
      (candidate) => candidate.kind === "checkpoint" && candidate.id === REPLICA_SINGLETON_ROW_ID,
    );
    let checkpoint: DirectoryCheckpoint | undefined;
    const invalidRows = [row];
    if (checkpointRow) {
      try {
        checkpoint = { ...deserializeDirectoryCheckpoint(checkpointRow.payload) };
        delete checkpoint[entity];
      } catch {
        invalidRows.push(checkpointRow);
      }
    }
    return this.repairInvalidDirectoryRows({
      serverId: row.serverId,
      invalidRows,
      checkpoint,
      checkpointRow,
      revision,
      checkpointGuard: "as-read",
    });
  }

  /**
   * Deletes invalid rows and rewrites the checkpoint without their entity cursors, compared
   * against the raw rows the plan was made from. The repair is queued behind earlier writes;
   * once committed, its entity cursors stay withheld from ordinary checkpoint writes.
   *
   * @returns Whether the repair committed while the scope could still publish; false when the
   *   comparison failed or the scope was invalidated. Rejects when storage fails.
   */
  private async repairInvalidDirectoryRows(plan: RepairPlan): Promise<boolean> {
    const { serverId, revision } = plan;
    const namespace: RepairNamespace = {
      serverId,
      incarnation: this.hostIncarnations.get(serverId),
      cancelled: false,
    };
    // A repair rewrites the whole checkpoint row, so it is planned and compared against the
    // complete raw checkpoint. Tracking only the workspace cursor would let a write to another
    // cursor slip between planning and commit.
    revision.workspaceAuthority = undefined;
    const changes = planRepairChanges(plan);
    const expected = repairExpectations(plan);
    this.repairNamespaces.add(namespace);
    const repair = this.commitRepair(this.writeQueue, namespace, plan, changes, expected);
    // Later writes wait for the repair; the queue tail only sequences work.
    this.writeQueue = repair.then(
      () => undefined,
      () => undefined,
    );
    return repair;
  }

  /**
   * Applies a planned repair once the queue ahead of it settles, then fences the repaired
   * cursors when the repair still belongs to the current registration of its host.
   */
  private async commitRepair(
    queueTail: Promise<void>,
    namespace: RepairNamespace,
    plan: RepairPlan,
    changes: ReplicaRowChanges,
    expected: ReplicaRowExpectation[],
  ): Promise<boolean> {
    try {
      await queueTail.catch(() => undefined);
      await this.prepareStore();
      if (!this.canPublishRead(plan.revision)) return false;
      const committed = await this.rowStore.applyIfUnchanged(changes, expected);
      if (!committed) return false;
      // A committed repair changes durable byte accounting even when publication is stale.
      // Rebuild before the next budget decision, without recreating removed/renamed namespaces.
      this.storedIndexPromise = null;
      if (this.isCurrentNamespace(namespace)) {
        this.fenceRepairedCursors(namespace.serverId, plan.invalidRows);
      }
      return this.canPublishRead(plan.revision);
    } finally {
      this.repairNamespaces.delete(namespace);
    }
  }

  /** Whether a repair's host is still active under the registration the repair started in. */
  private isCurrentNamespace(namespace: RepairNamespace): boolean {
    return (
      !namespace.cancelled &&
      this.activeServerIds.has(namespace.serverId) &&
      this.hostIncarnations.get(namespace.serverId) === namespace.incarnation
    );
  }

  /** Withholds the entity cursors of repaired rows until a complete baseline is persisted. */
  private fenceRepairedCursors(serverId: string, repairedRows: readonly ReplicaRow[]): void {
    const invalid =
      this.invalidDirectoryCursors.get(serverId) ?? new Set<keyof DirectoryCheckpoint>();
    for (const row of repairedRows) {
      const entity = directoryEntityForRow(row);
      if (entity) invalid.add(entity);
    }
    if (invalid.size) {
      this.invalidDirectoryCursors.set(serverId, invalid);
    }
  }

  commitDirectoryMutations(
    serverId: string,
    mutations: readonly DirectoryReplicaMutation[],
    checkpoint?: DirectoryCheckpoint,
  ): void {
    if (!this.activeServerIds.has(serverId)) return;
    if (this.invalidatedHosts.has(serverId)) return;
    for (const mutation of mutations) {
      if (mutation.type === "delete") {
        this.queueEntityDelete(serverId, mutation.kind, mutation.id);
      } else {
        this.queueUpsert({
          serverId,
          kind: mutation.kind,
          id: mutation.id,
          value: mutation.value,
        } as StructuredReplicaUpsert);
      }
    }
    if (checkpoint) {
      this.queueUpsert({
        serverId,
        kind: "checkpoint",
        id: REPLICA_SINGLETON_ROW_ID,
        value: checkpoint,
      });
    }
    this.schedulePersist();
  }

  replaceDirectoryBaseline(serverId: string, directory: CachedDirectory): void {
    if (!this.activeServerIds.has(serverId)) return;
    this.invalidateHostReads(serverId, ["agent", "workspace", "project", "checkpoint"]);
    // Replacing the directory must not discard independently accepted timeline changes.
    for (const [key, row] of this.pendingUpserts) {
      if (row.serverId === serverId && row.kind !== "timeline") this.pendingUpserts.delete(key);
    }
    for (const [key, row] of this.pendingDeletes) {
      if (row.serverId === serverId && row.kind !== "timeline") this.pendingDeletes.delete(key);
    }
    this.pendingBaselines.add(serverId);
    for (const [id, value] of directory.agents) {
      this.queueUpsert({ serverId, kind: "agent", id, value });
    }
    for (const [id, value] of directory.workspaces) {
      this.queueUpsert({ serverId, kind: "workspace", id, value });
    }
    for (const [id, value] of directory.projects) {
      this.queueUpsert({ serverId, kind: "project", id, value });
    }
    if (directory.checkpoint) {
      this.queueUpsert({
        serverId,
        kind: "checkpoint",
        id: REPLICA_SINGLETON_ROW_ID,
        value: directory.checkpoint,
      });
    }
    this.schedulePersist();
  }

  commitTimeline(serverId: string, agentId: string, timeline: CachedTimeline): void {
    if (!this.activeServerIds.has(serverId)) return;
    if (timeline.agentId !== agentId) throw new Error("Timeline cache key does not match payload");
    this.queueUpsert({ serverId, kind: "timeline", id: agentId, value: timeline });
    this.schedulePersist();
  }

  setHosts(serverIds: Iterable<string>): void {
    const next = new Set(serverIds);
    const removed = [...this.activeServerIds].filter((serverId) => !next.has(serverId));
    const added = [...next].filter((serverId) => !this.activeServerIds.has(serverId));
    for (const serverId of [...removed, ...added]) {
      this.invalidateHostReads(serverId);
      this.hostIncarnations.set(serverId, Symbol(serverId));
    }
    this.activeServerIds.clear();
    for (const serverId of next) this.activeServerIds.add(serverId);
    for (const serverId of removed) {
      this.invalidDirectoryCursors.delete(serverId);
      for (const namespace of this.repairNamespaces) {
        if (namespace.serverId === serverId) {
          namespace.cancelled = true;
        }
      }
      this.removeStoredHost(serverId);
      this.dropPendingHostChanges(serverId);
      this.invalidatedHosts.delete(serverId);
      this.queueOperation(() => this.rowStore.deleteHost(serverId));
    }
  }

  reconcileServerId(oldServerId: string, newServerId: string): void {
    this.hostIncarnations.set(oldServerId, Symbol(oldServerId));
    this.hostIncarnations.set(newServerId, Symbol(newServerId));
    for (const namespace of this.repairNamespaces) {
      if (namespace.cancelled) continue;
      if (namespace.serverId === oldServerId) namespace.serverId = newServerId;
      if (namespace.serverId === newServerId) {
        namespace.incarnation = this.hostIncarnations.get(newServerId);
      }
    }
    const invalid = this.invalidDirectoryCursors.get(oldServerId);
    if (invalid) {
      const combined =
        this.invalidDirectoryCursors.get(newServerId) ?? new Set<keyof DirectoryCheckpoint>();
      for (const entity of invalid) combined.add(entity);
      this.invalidDirectoryCursors.set(newServerId, combined);
      this.invalidDirectoryCursors.delete(oldServerId);
    }
    this.invalidateHostReads(oldServerId);
    this.invalidateHostReads(newServerId);
    const rows = this.storedRows.get(oldServerId);
    if (rows) {
      const newRows = this.storedRows.get(newServerId) ?? new Map<string, ReplicaRow>();
      this.totalBytes -=
        (this.hostBytes.get(oldServerId) ?? 0) + (this.hostBytes.get(newServerId) ?? 0);
      this.storedRows.delete(oldServerId);
      for (const [key, row] of rows) newRows.set(key, { ...row, serverId: newServerId });
      this.storedRows.set(newServerId, newRows);
      const bytes = [...newRows.values()].reduce((sum, row) => sum + rowBytes(row), 0);
      this.hostBytes.delete(oldServerId);
      this.hostBytes.set(newServerId, bytes);
      this.totalBytes += bytes;
      this.hostWriteOrder.delete(oldServerId);
      this.touchHost(newServerId);
    }
    this.renamePendingHostChanges(oldServerId, newServerId);
    if (this.activeServerIds.delete(oldServerId)) this.activeServerIds.add(newServerId);
    this.queueOperation(() => this.rowStore.renameHost(oldServerId, newServerId));
  }

  async flush(): Promise<void> {
    await this.syncPending();
  }

  /** Resolves to whether every pending change reached the store. */
  private async syncPending(): Promise<boolean> {
    const persisted = await this.persist();
    await this.writeQueue.catch(() => undefined);
    return persisted;
  }

  private async flushPending(): Promise<void> {
    await this.persist();
  }

  private async persist(): Promise<boolean> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.hasPendingChanges()) return true;
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const pending = this.drainPendingChanges();
        const baselineIncarnations = new Map(
          [...pending.baselines].map((id) => [id, this.hostIncarnations.get(id)]),
        );
        try {
          await this.prepareStore();
          await this.ensureStoredIndex();
          const changes = this.materializePendingChanges(pending);
          const { changes: boundedChanges, evicted } = await this.fitChangesToBudget(changes);
          if (boundedChanges.upserts.length > 0 || boundedChanges.deletes.length > 0) {
            await this.rowStore.apply(boundedChanges);
            this.applyStoredChanges(boundedChanges);
          }
          for (const serverId of pending.baselines) {
            if (!evicted.has(serverId)) {
              this.invalidatedHosts.delete(serverId);
              // A host re-registered during the write keeps the fences of its new registration.
              const sameIncarnation =
                this.hostIncarnations.get(serverId) === baselineIncarnations.get(serverId);
              if (sameIncarnation) {
                this.invalidDirectoryCursors.delete(serverId);
              }
            }
          }
        } catch {
          this.restorePendingChanges(pending);
          if (this.hasPendingChanges()) this.schedulePersist();
          return false;
        }
        return true;
      });
    // The queue only sequences writes; every consumer decides for itself what a failure means.
    this.writeQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private queueEntityDelete(serverId: string, kind: ReplicaRowKind, id: string): void {
    this.queueDelete({ serverId, kind, id });
  }

  private queueUpsert(row: StructuredReplicaUpsert): void {
    this.invalidateRowReads(row);
    const key = pendingRowKey(row);
    this.pendingDeletes.delete(key);
    this.pendingUpserts.set(key, row);
  }

  private queueDelete(key: ReplicaRowKey): void {
    this.invalidateRowReads(key);
    const pendingKey = pendingRowKey(key);
    this.pendingUpserts.delete(pendingKey);
    this.pendingDeletes.set(pendingKey, key);
  }

  private hasPendingChanges(): boolean {
    return (
      this.pendingUpserts.size > 0 || this.pendingDeletes.size > 0 || this.pendingBaselines.size > 0
    );
  }

  /**
   * Withholds repaired entity cursors from ordinary checkpoint writes. A complete baseline
   * replaces every directory row, so it may write them again.
   */
  private checkpointForWrite(
    serverId: string,
    value: DirectoryCheckpoint,
    { completeBaseline }: { completeBaseline: boolean },
  ): DirectoryCheckpoint {
    const checkpoint = { ...value };
    if (!completeBaseline) {
      for (const entity of this.invalidDirectoryCursors.get(serverId) ?? []) {
        delete checkpoint[entity];
      }
    }
    return checkpoint;
  }

  /**
   * The workspace authority a pending checkpoint upsert will have once written. It is projected
   * through the stored form so it compares equal to the row it becomes: the stored schema fixes
   * key order and rejects values a reader would treat as provisional.
   */
  private pendingCheckpointAuthority(serverId: string, checkpoint: DirectoryCheckpoint): string {
    const value = this.checkpointForWrite(serverId, checkpoint, {
      completeBaseline: this.pendingBaselines.has(serverId),
    });
    return workspaceAuthorityProjection(JSON.stringify(serializeDirectoryCheckpoint(value)));
  }

  /**
   * Whether a pending change affects a scope. A checkpoint upsert affects a workspace-authority
   * scope only when it changes the workspace cursor the scope observed.
   */
  private pendingReadChange(
    read: ReplicaRead,
    row: ReplicaRowKey | StructuredReplicaUpsert,
  ): boolean {
    if (!matchesReplicaRead(read, row)) return false;
    if (!read.workspaceAuthority || row.kind !== "checkpoint" || !("value" in row)) return true;
    return read.workspaceAuthority.observed !== this.pendingCheckpointAuthority(row.serverId, row.value);
  }

  private hasPendingReadChanges(read: ReplicaRead): boolean {
    if (
      this.pendingBaselines.has(read.serverId) &&
      read.kinds.some((kind) => kind !== "timeline")
    ) {
      return true;
    }
    return (
      [...this.pendingUpserts.values()].some((row) => this.pendingReadChange(read, row)) ||
      [...this.pendingDeletes.values()].some((row) => matchesReplicaRead(read, row))
    );
  }

  private invalidateRowReads(row: ReplicaRowKey | StructuredReplicaUpsert): void {
    for (const read of this.activeReads) {
      if (!matchesReplicaRead(read, row)) continue;
      if (read.workspaceAuthority && row.kind === "checkpoint" && "value" in row) {
        const projection = this.pendingCheckpointAuthority(row.serverId, row.value);
        read.workspaceAuthority.changes.add(projection);
        const { observed } = read.workspaceAuthority;
        const changesObservedAuthority = observed !== undefined && observed !== projection;
        if (changesObservedAuthority) {
          read.invalidated = true;
        }
      } else {
        read.invalidated = true;
      }
    }
  }

  private invalidateHostReads(serverId: string, kinds?: readonly ReplicaRowKind[]): void {
    for (const read of this.activeReads) {
      if (
        read.serverId === serverId &&
        (!kinds || kinds.some((kind) => read.kinds.includes(kind)))
      ) {
        read.invalidated = true;
      }
    }
  }

  private hasPendingHostChanges(serverId: string): boolean {
    if (this.pendingBaselines.has(serverId)) return true;
    for (const row of this.pendingUpserts.values()) {
      if (row.serverId === serverId) return true;
    }
    for (const row of this.pendingDeletes.values()) {
      if (row.serverId === serverId) return true;
    }
    return false;
  }

  private drainPendingChanges(): PendingReplicaChanges {
    const changes = {
      upserts: [...this.pendingUpserts.values()],
      deletes: [...this.pendingDeletes.values()],
      baselines: this.pendingBaselines,
    };
    this.pendingUpserts = new Map();
    this.pendingDeletes = new Map();
    this.pendingBaselines = new Set();
    return changes;
  }

  private materializePendingChanges(pending: PendingReplicaChanges): ReplicaRowChanges {
    const deletes = new Map(pending.deletes.map((row) => [pendingRowKey(row), row]));
    const upserts: ReplicaRow[] = [];
    for (const upsert of pending.upserts) {
      const row = this.materializeUpsert(upsert, {
        completeBaseline: pending.baselines.has(upsert.serverId),
      });
      if (row) upserts.push(row);
      else deletes.set(pendingRowKey(upsert), upsert);
    }
    for (const serverId of pending.baselines) {
      const replacementKeys = new Set(
        upserts.filter((row) => row.serverId === serverId && row.kind !== "timeline").map(rowKey),
      );
      for (const row of this.storedRows.get(serverId)?.values() ?? []) {
        if (row.kind !== "timeline" && !replacementKeys.has(rowKey(row))) {
          deletes.set(pendingRowKey(row), row);
        }
      }
    }
    return { upserts, deletes: [...deletes.values()] };
  }

  /** @param options.completeBaseline Whether this write carries a complete directory baseline. */
  private materializeUpsert(
    upsert: StructuredReplicaUpsert,
    { completeBaseline }: { completeBaseline: boolean },
  ): ReplicaRow | null {
    let value: unknown;
    switch (upsert.kind) {
      case "agent":
        value = serializeAgent(upsert.value);
        break;
      case "workspace":
        value = serializeWorkspace(upsert.value);
        break;
      case "project":
        value = serializeProject(upsert.value);
        break;
      case "timeline":
        value = serializeTimeline(upsert.value);
        if (!value) return null;
        break;
      case "checkpoint": {
        value = serializeDirectoryCheckpoint(
          this.checkpointForWrite(upsert.serverId, upsert.value, { completeBaseline }),
        );
        break;
      }
    }
    return {
      serverId: upsert.serverId,
      kind: upsert.kind,
      id: upsert.id,
      payload: JSON.stringify(value),
    };
  }

  private restorePendingChanges(changes: PendingReplicaChanges): void {
    for (const serverId of changes.baselines) {
      if (this.activeServerIds.has(serverId)) this.pendingBaselines.add(serverId);
    }
    for (const key of changes.deletes) {
      const pendingKey = pendingRowKey(key);
      if (
        this.activeServerIds.has(key.serverId) &&
        !this.pendingUpserts.has(pendingKey) &&
        !this.pendingDeletes.has(pendingKey)
      ) {
        this.queueDelete(key);
      }
    }
    for (const row of changes.upserts) {
      const pendingKey = pendingRowKey(row);
      if (
        this.activeServerIds.has(row.serverId) &&
        !this.pendingUpserts.has(pendingKey) &&
        !this.pendingDeletes.has(pendingKey)
      ) {
        this.queueUpsert(row);
      }
    }
  }

  private applyStoredChanges(changes: ReplicaRowChanges): void {
    const touchedServerIds = new Set<string>();
    for (const key of changes.deletes) {
      const rows = this.storedRows.get(key.serverId);
      const previous = rows?.get(rowKey(key));
      if (previous) {
        rows?.delete(rowKey(key));
        this.adjustHostBytes(key.serverId, -rowBytes(previous));
      }
      touchedServerIds.add(key.serverId);
    }
    for (const row of changes.upserts) {
      const rows = this.storedRows.get(row.serverId) ?? new Map<string, ReplicaRow>();
      const previous = rows.get(rowKey(row));
      const previousBytes = previous ? rowBytes(previous) : 0;
      rows.set(rowKey(row), row);
      this.storedRows.set(row.serverId, rows);
      this.adjustHostBytes(row.serverId, rowBytes(row) - previousBytes);
      touchedServerIds.add(row.serverId);
    }
    for (const serverId of touchedServerIds) {
      if ((this.storedRows.get(serverId)?.size ?? 0) === 0) {
        this.removeStoredHost(serverId);
      } else {
        this.touchHost(serverId);
      }
    }
  }

  private adjustHostBytes(serverId: string, delta: number): void {
    this.hostBytes.set(serverId, (this.hostBytes.get(serverId) ?? 0) + delta);
    this.totalBytes += delta;
  }

  private touchHost(serverId: string): void {
    this.hostWriteOrder.delete(serverId);
    this.hostWriteOrder.set(serverId, true);
  }

  private async fitChangesToBudget(
    changes: ReplicaRowChanges,
  ): Promise<{ changes: ReplicaRowChanges; evicted: Set<string> }> {
    const touchedServerIds = new Set<string>();
    for (const key of changes.deletes) touchedServerIds.add(key.serverId);
    for (const row of changes.upserts) touchedServerIds.add(row.serverId);

    const projectedRows = new Map<string, Map<string, ReplicaRow>>();
    const projectedBytes = new Map(this.hostBytes);
    for (const serverId of touchedServerIds) {
      projectedRows.set(serverId, new Map(this.storedRows.get(serverId)));
    }
    for (const key of changes.deletes) {
      projectedRows.get(key.serverId)?.delete(rowKey(key));
    }
    for (const row of changes.upserts) {
      projectedRows.get(row.serverId)?.set(rowKey(row), row);
    }
    for (const [serverId, rows] of projectedRows) {
      projectedBytes.set(
        serverId,
        [...rows.values()].reduce((sum, row) => sum + rowBytes(row), 0),
      );
    }

    const writeOrder = [...this.hostWriteOrder.keys()].filter(
      (serverId) => !touchedServerIds.has(serverId),
    );
    writeOrder.push(...touchedServerIds);
    let projectedTotal = [...projectedBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
    const evicted = new Set<string>();
    while (projectedTotal > this.maxBytes) {
      const serverId = writeOrder.shift();
      if (serverId === undefined) break;
      const bytes = projectedBytes.get(serverId) ?? 0;
      projectedTotal -= bytes;
      projectedBytes.delete(serverId);
      evicted.add(serverId);
      this.invalidatedHosts.add(serverId);
      if (this.storedRows.has(serverId)) await this.rowStore.deleteHost(serverId);
      this.removeStoredHost(serverId);
    }

    return {
      changes: {
        upserts: changes.upserts.filter((row) => !evicted.has(row.serverId)),
        deletes: changes.deletes.filter((key) => !evicted.has(key.serverId)),
      },
      evicted,
    };
  }

  private removeStoredHost(serverId: string): void {
    this.totalBytes -= this.hostBytes.get(serverId) ?? 0;
    this.storedRows.delete(serverId);
    this.hostBytes.delete(serverId);
    this.hostWriteOrder.delete(serverId);
  }

  private dropPendingHostChanges(serverId: string): void {
    this.pendingBaselines.delete(serverId);
    for (const [key, row] of this.pendingUpserts) {
      if (row.serverId === serverId) this.pendingUpserts.delete(key);
    }
    for (const [key, row] of this.pendingDeletes) {
      if (row.serverId === serverId) this.pendingDeletes.delete(key);
    }
  }

  private renamePendingHostChanges(oldServerId: string, newServerId: string): void {
    const changes = this.drainPendingChanges();
    for (const key of changes.deletes) {
      this.queueDelete(key.serverId === oldServerId ? { ...key, serverId: newServerId } : key);
    }
    for (const row of changes.upserts) {
      this.queueUpsert(row.serverId === oldServerId ? { ...row, serverId: newServerId } : row);
    }
    for (const serverId of changes.baselines) {
      this.pendingBaselines.add(serverId === oldServerId ? newServerId : serverId);
    }
    if (this.invalidatedHosts.delete(oldServerId)) this.invalidatedHosts.add(newServerId);
  }

  private prepareStore(): Promise<void> {
    this.preparePromise ??= (async () => {
      await this.rowStore.open();
      // COMPAT(replica-blob-cache): remove after 2026-11
      await this.clearLegacyCache().catch(() => undefined);
    })();
    return this.preparePromise;
  }

  private ensureStoredIndex(): Promise<void> {
    this.storedIndexPromise ??= this.rowStore.readAll().then(async (hosts) => {
      this.storedRows.clear();
      this.hostBytes.clear();
      this.hostWriteOrder.clear();
      this.totalBytes = 0;
      for (const host of hosts) {
        if (!this.activeServerIds.has(host.serverId)) {
          await this.rowStore.deleteHost(host.serverId);
          continue;
        }
        const rows = new Map(host.rows.map((row) => [rowKey(row), row]));
        const bytes = host.rows.reduce((sum, row) => sum + rowBytes(row), 0);
        this.storedRows.set(host.serverId, rows);
        this.hostBytes.set(host.serverId, bytes);
        this.totalBytes += bytes;
        this.touchHost(host.serverId);
      }
      return undefined;
    });
    return this.storedIndexPromise;
  }

  private queueOperation(operation: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await this.prepareStore();
        await operation();
        return undefined;
      })
      .catch(() => undefined);
    return this.writeQueue;
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flushPending();
    }, PERSIST_DELAY_MS);
  }
}
