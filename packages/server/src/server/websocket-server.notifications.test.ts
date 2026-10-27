import { NotificationReceipts } from "@getpaseo/protocol/notification-receipts";
import { WorkspaceNotificationReceipts } from "./notifications/workspace-receipts.js";
import { SessionDelivery } from "./session/owned-subscriptions/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { PushNotificationSender, PushPayload } from "./push/index.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";

const WORKSPACE_ID = "workspace-1";

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: function Session() {
    return {};
  },
}));

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

interface WebSocketServerInternals {
  sessions: Map<unknown, unknown>;
  broadcastAgentAttention(params: {
    agentId: string;
    reason: string;
    preview?: string;
    providerId?: string;
    provider?: string;
    timestamp?: string;
  }): Promise<void>;
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];

  async send(payload: PushPayload): Promise<void> {
    this.sent.push(payload);
  }
}

function createServer(
  agentManagerOverrides?: Record<string, unknown>,
  registries?: { projects: ProjectRegistry; workspaces: WorkspaceRegistry },
  configStore?: DaemonConfigStore,
) {
  let attentionMode = true;
  const pushNotifications = new RecordingPushNotificationSender();
  const agentManager = {
    subscribe: vi.fn(() => () => {}),
    setAgentAttentionCallback: vi.fn(),
    setAttentionHost: vi.fn(),
    setAttentionPresentationEnabled: vi.fn((enabled: boolean) => {
      attentionMode = enabled;
    }),
    get agentAwareAttentionEnabled() {
      return attentionMode;
    },
    getAgent: vi.fn(() => ({
      id: "agent-1",
      workspaceId: WORKSPACE_ID,
      pendingPermissions: new Map(),
      attention: { requiresAttention: false },
    })),
    getLastAssistantMessage: vi.fn(async () => null),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: {
        totalItems: 0,
        maxItemsPerAgent: 0,
      },
    })),
    ...agentManagerOverrides,
  };
  const daemonConfigStore = {
    get: () => ({ notifications: { agentAwareAttention: true } }),
    onApply: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
  };

  const server = new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(createLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    configStore ?? createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set() },
    createWorkspaceAutoNameStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    registries?.projects,
    registries?.workspaces,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pushNotifications,
    createProviderSnapshotManagerStub().manager,
  );

  return { server, agentManager, pushNotifications };
}

function createOpenSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

function createSessionWithActivity(
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  subscribed = true,
) {
  return {
    getClientActivity: vi.fn(() => activity),
    supports: () => false,
    supportsForSource: () => false,
    subscribesToAgent: vi.fn(async () => subscribed),
  };
}

function connectClient(
  server: VoiceAssistantWebSocketServer,
  activity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  options: { subscribed?: boolean; refreshAttention?: () => Promise<void> } = {},
) {
  const ws = createOpenSocket();
  const delivery = new SessionDelivery(() => {});
  delivery.attach(ws, false);
  asInternals<WebSocketServerInternals>(server).sessions.set(ws, {
    kind: "trusted",
    session: {
      ...createSessionWithActivity(activity, options.subscribed ?? true),
      delivery,
      publish: (message: SessionOutboundMessage) =>
        ws.send(JSON.stringify(wrapSessionMessage(message))),
      wantsSourceNotification: () => true,
      refreshAttentionPresentation: options.refreshAttention ?? (async () => {}),
    },
    clientId: "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function readAttentionRequiredMessage(ws: ReturnType<typeof createOpenSocket>) {
  const rawMessage = ws.send.mock.calls[0]?.[0];
  expect(typeof rawMessage).toBe("string");
  if (typeof rawMessage !== "string") throw new Error("Expected string WebSocket frame");
  const message = JSON.parse(rawMessage);
  expect(message.type).toBe("session");
  expect(message.message.type).toBe("agent_stream");
  expect(message.message.payload.event.type).toBe("attention_required");
  return message.message.payload.event;
}

describe("VoiceAssistantWebSocketServer notification payloads", () => {
  it("reserves attention receipts before overlapping message preparation finishes out of order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-notification-overlap-"));
    let releaseFirst!: () => void;
    let signalFirstRead!: () => void;
    const firstPreparation = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstReadStarted = new Promise<void>((resolve) => {
      signalFirstRead = resolve;
    });
    try {
      const logger = createStub<pino.Logger>(createLogger());
      const projects = new FileBackedProjectRegistry(join(directory, "projects.json"), logger);
      const workspaces = new FileBackedWorkspaceRegistry(
        join(directory, "workspaces.json"),
        logger,
      );
      const firstTimestamp = "2026-10-21T12:00:00.000Z";
      const secondTimestamp = "2026-10-21T12:00:01.000Z";
      await workspaces.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: WORKSPACE_ID,
          projectId: "project-1",
          cwd: directory,
          kind: "directory",
          displayName: "Overlap",
          createdAt: firstTimestamp,
          updatedAt: firstTimestamp,
        }),
      );
      const agent = {
        id: "agent-1",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
        attention: { requiresAttention: true, attentionTimestamp: new Date(firstTimestamp) },
      };
      let messageReads = 0;
      const { server, pushNotifications } = createServer(
        {
          getAgent: () => agent,
          getLastAssistantMessage: async () => {
            messageReads++;
            if (messageReads === 1) {
              signalFirstRead();
              await firstPreparation;
              return "Earlier completion";
            }
            return "Later completion";
          },
        },
        { projects, workspaces },
      );
      const broadcaster = asInternals<WebSocketServerInternals>(server);
      const earlier = broadcaster.broadcastAgentAttention({
        agentId: agent.id,
        reason: "finished",
        provider: "codex",
      });
      await firstReadStarted;
      agent.attention = { requiresAttention: true, attentionTimestamp: new Date(secondTimestamp) };
      await broadcaster.broadcastAgentAttention({
        agentId: agent.id,
        reason: "finished",
        provider: "codex",
      });
      releaseFirst();
      await earlier;

      // Preparation finishes B then A, while receipt identity stays in original callback order.
      expect(
        pushNotifications.sent.map((notification) => ({
          sequence: notification.data?.notificationSequence,
          timestamp: notification.data?.attentionTimestamp,
        })),
      ).toEqual([
        { sequence: 2, timestamp: secondTimestamp },
        { sequence: 1, timestamp: firstTimestamp },
      ]);
      const stored = await workspaces.get(WORKSPACE_ID);
      expect(stored?.notificationReceipts?.attentionEvents?.[agent.id]).toEqual({
        sequence: 2,
        timestamp: secondTimestamp,
      });
      const receipts = new WorkspaceNotificationReceipts(workspaces, async () => {});
      await receipts.acknowledge(WORKSPACE_ID, {
        kind: "workspace",
        acknowledgementId: "opened-before-second",
        observedReadId: null,
        throughSequence: 1,
        attention: [{ agentId: agent.id, timestamp: firstTimestamp }],
      });
      const acknowledged = new NotificationReceipts(
        (await workspaces.get(WORKSPACE_ID))?.notificationReceipts,
      );
      expect(acknowledged.includes(1)).toBe(true);
      expect(acknowledged.includes(2)).toBe(false);
      expect(acknowledged.snapshot().attentionEvents?.[agent.id]).toEqual({
        sequence: 2,
        timestamp: secondTimestamp,
      });
    } finally {
      releaseFirst();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses renamed workspace and project records for push and desktop recipients", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-notification-context-"));
    try {
      const logger = createStub<pino.Logger>(createLogger());
      const projects = new FileBackedProjectRegistry(join(directory, "projects.json"), logger);
      const workspaces = new FileBackedWorkspaceRegistry(
        join(directory, "workspaces.json"),
        logger,
      );
      await projects.initialize();
      await workspaces.initialize();
      const timestamp = new Date().toISOString();
      await projects.upsert(
        createPersistedProjectRecord({
          projectId: "project-1",
          rootPath: directory,
          kind: "git",
          displayName: "Derived project",
          customName: "Chosen project",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      await workspaces.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: WORKSPACE_ID,
          projectId: "project-1",
          cwd: directory,
          kind: "worktree",
          displayName: "branch-name",
          title: "Chosen workspace",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      const { server, pushNotifications } = createServer(undefined, { projects, workspaces });
      const socket = connectClient(server, null);
      await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
        agentId: "agent-1",
        reason: "finished",
        provider: "claude",
      });
      const notification = readAttentionRequiredMessage(socket).notification;
      expect(notification.title).toBe("Chosen workspace · Chosen project");
      expect(notification.body).toBe("Agent finished\nFinished working.");
      expect(notification.data.workspaceId).toBe(WORKSPACE_ID);
      expect(pushNotifications.sent).toEqual([notification]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not emit attention or include presence without an agent-directory subscription", async () => {
    const { server, pushNotifications } = createServer();
    const now = new Date();
    const unsubscribed = connectClient(
      server,
      {
        deviceType: "web",
        appVisible: true,
        focusedAgentId: "agent-1",
        lastActivityAt: now,
      },
      { subscribed: false },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(unsubscribed.send).not.toHaveBeenCalled();
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("uses assistant preview text for push notifications with markdown removed", async () => {
    const getLastAssistantMessage = vi.fn(
      async () => "**Done**. Updated `README.md` and [link](https://example.com).",
    );
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        id: "agent-1",
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
        attention: { requiresAttention: false },
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toEqual([
      {
        title: "Agent finished",
        body: "Done. Updated README.md and link.",
        data: {
          serverId: "srv-test",
          workspaceId: WORKSPACE_ID,
          agentId: "agent-1",
          reason: "finished",
        },
      },
    ]);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1");
  });

  it("sends push notifications regardless of UI label presence", async () => {
    const getLastAssistantMessage = vi.fn(async () => "Done.");
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        id: "agent-2",
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        labels: {},
        pendingPermissions: new Map(),
        attention: { requiresAttention: false },
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-2");
  });

  it("routes a hidden stale focused browser tab's notification to the present Electron web client", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    const electronWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-Y",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    const firefoxWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-X",
      lastActivityAt: new Date(nowMs - 300_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-X",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(electronWs).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(firefoxWs).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes non-error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("does not push error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "error",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });
});

it("attention preference committed host config refreshes both devices without attention replay", async () => {
  const home = mkdtempSync(join(tmpdir(), "attention-ws-config-"));
  try {
    const store = new DaemonConfigStore(home, {
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    });
    const { server, agentManager, pushNotifications } = createServer(undefined, undefined, store);
    const firstRefresh = vi.fn(async () => {});
    const secondRefresh = vi.fn(async () => {});
    const first = connectClient(server, null, { refreshAttention: firstRefresh });
    const second = connectClient(server, null, { refreshAttention: secondRefresh });
    store.patch({ notifications: { agentAwareAttention: false } });
    expect(agentManager.agentAwareAttentionEnabled).toBe(false);
    expect(firstRefresh).toHaveBeenCalledTimes(1);
    expect(secondRefresh).toHaveBeenCalledTimes(1);
    for (const ws of [first, second]) {
      expect(
        ws.send.mock.calls
          .map(([frame]) => JSON.parse(String(frame)))
          .some((frame) => frame.message?.type === "agent_attention_required"),
      ).toBe(false);
    }
    expect(pushNotifications.sent).toEqual([]);
    const release = store.onApply(() => {
      throw new Error("Reject next apply");
    });
    expect(() => store.patch({ notifications: { agentAwareAttention: true } })).toThrow(
      "Reject next apply",
    );
    expect(agentManager.agentAwareAttentionEnabled).toBe(false);
    expect(firstRefresh).toHaveBeenCalledTimes(1);
    expect(secondRefresh).toHaveBeenCalledTimes(1);
    release();
    store.patch({ notifications: { agentAwareAttention: true } });
    expect(agentManager.agentAwareAttentionEnabled).toBe(true);
    expect(firstRefresh).toHaveBeenCalledTimes(2);
    expect(secondRefresh).toHaveBeenCalledTimes(2);
    expect(pushNotifications.sent).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
