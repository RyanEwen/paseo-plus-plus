import { ServerInfoStatusPayloadSchema } from "./messages.js";
import { NotificationReceipts } from "./notification-receipts.js";
import { describe, expect, it } from "vitest";
import {
  buildAgentAttentionNotificationPayload,
  findLatestAssistantMessageFromTimeline,
  findLatestPermissionRequest,
  withNotificationWorkspaceContext,
} from "./agent-attention-notification.js";

describe("buildAgentAttentionNotificationPayload", () => {
  it("puts workspace identity first and retains permission details and routing", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "permission",
      serverId: "host",
      workspaceId: "ws",
      agentId: "agent",
      workspaceName: "Review checkout",
      projectName: "Paseo++",
      permissionRequest: {
        id: "p",
        provider: "codex",
        name: "exec",
        kind: "tool",
        title: "Run tests",
      },
    });
    expect(payload.title).toBe("Review checkout · Paseo++");
    expect(payload.body).toBe("Agent needs permission\nRun tests");
    expect(payload.data.workspaceId).toBe("ws");
  });

  it("omits duplicate or crowded project labels without truncating workspace identity", () => {
    const notification = { title: "Terminal needs attention", body: "Build" };
    expect(
      withNotificationWorkspaceContext(notification, {
        workspaceName: "Paseo",
        projectName: "Paseo",
      }).title,
    ).toBe("Paseo");
    const workspaceName = "A long but meaningful workspace title ".repeat(3).trim();
    expect(
      withNotificationWorkspaceContext(notification, { workspaceName, projectName: "Project" })
        .title,
    ).toBe(workspaceName);
    expect(withNotificationWorkspaceContext(notification, { workspaceName: " \n " })).toBe(
      notification,
    );
  });

  it("carries the workspace needed to open a cold agent destination", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "finished",
      serverId: "srv-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });

    expect(payload.data).toEqual({
      serverId: "srv-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      reason: "finished",
    });
  });

  it("builds finished notifications from markdown assistant text", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "finished",
      serverId: "srv-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      assistantMessage: "**Done**. Updated `README.md` and [link](https://example.com).",
    });

    expect(payload).toEqual({
      title: "Agent finished",
      body: "Done. Updated README.md and link.",
      data: {
        serverId: "srv-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        reason: "finished",
      },
    });
  });

  it("builds permission notifications from request details", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "permission",
      serverId: "srv-2",
      workspaceId: "workspace-2",
      agentId: "agent-2",
      permissionRequest: {
        id: "perm-1",
        provider: "claude",
        name: "exec",
        kind: "tool",
        title: "**Approve command**",
        description: "Run `git push`",
      },
    });

    expect(payload).toEqual({
      title: "Agent needs permission",
      body: "Approve command - Run git push",
      data: {
        serverId: "srv-2",
        workspaceId: "workspace-2",
        agentId: "agent-2",
        reason: "permission",
      },
    });
  });

  it("uses error-specific defaults when reason is error", () => {
    const payload = buildAgentAttentionNotificationPayload({
      reason: "error",
      serverId: "srv-3",
      workspaceId: "workspace-3",
      agentId: "agent-3",
    });

    expect(payload).toEqual({
      title: "Agent needs attention",
      body: "Encountered an error.",
      data: {
        serverId: "srv-3",
        workspaceId: "workspace-3",
        agentId: "agent-3",
        reason: "error",
      },
    });
  });
});

describe("findLatestAssistantMessageFromTimeline", () => {
  it("joins the latest contiguous assistant chunks", () => {
    expect(
      findLatestAssistantMessageFromTimeline([
        { type: "user_message", text: "start" },
        { type: "assistant_message", text: "Part " },
        { type: "assistant_message", text: "one" },
        { type: "reasoning", text: "thinking..." },
        { type: "assistant_message", text: "Done " },
        { type: "assistant_message", text: "now" },
      ]),
    ).toBe("Done now");
  });
});

describe("findLatestPermissionRequest", () => {
  it("returns the most recently inserted request", () => {
    const pending = new Map([
      ["first", { id: "first", provider: "claude", name: "a", kind: "tool" } as const],
      ["second", { id: "second", provider: "claude", name: "b", kind: "tool" } as const],
    ]);

    expect(findLatestPermissionRequest(pending)?.id).toBe("second");
  });
});

describe("Workspace notification receipts", () => {
  it("keeps workspace notification receipt support optional in server features", () => {
    const withoutFeatures = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "older",
    });
    expect(withoutFeatures.features).toBeUndefined();
    const older = {
      status: "server_info",
      serverId: "older",
      features: { workspaceMarkUnread: true },
    };
    expect(
      ServerInfoStatusPayloadSchema.parse(older).features?.workspaceNotificationReceipts,
    ).toBeUndefined();
    const current = ServerInfoStatusPayloadSchema.parse({
      ...older,
      features: { ...older.features, workspaceNotificationReceipts: true },
    });
    expect(current.features?.workspaceNotificationReceipts).toBe(true);
    expect(current.features?.workspaceMarkUnread).toBe(true);
  });

  it("keeps newer events and exact single-dismiss gaps across a durable round trip", () => {
    const receipts = new NotificationReceipts();
    for (let i = 0; i < 4; i++) receipts.issue();
    receipts.acknowledge({
      kind: "workspace",
      acknowledgementId: "open-1",
      throughSequence: 2,
      attention: [],
    });
    receipts.acknowledge({
      kind: "event",
      acknowledgementId: "dismiss-4",
      sequence: 4,
      attention: [],
    });
    const restored = new NotificationReceipts(JSON.parse(JSON.stringify(receipts.snapshot())));
    expect([1, 2, 3, 4].map((sequence) => restored.includes(sequence))).toEqual([
      true,
      true,
      false,
      true,
    ]);
    expect(restored.issue()).toBe(5);
    expect(restored.includes(5)).toBe(false);
    restored.acknowledge({
      kind: "event",
      acknowledgementId: "dismiss-3",
      sequence: 3,
      attention: [],
    });
    expect(restored.snapshot().acknowledgedThrough).toBe(4);
    expect(restored.snapshot().dismissedSequences).toEqual([]);
  });

  it("never acknowledges a future or unidentified notification", () => {
    const receipts = new NotificationReceipts();
    receipts.issue();
    expect(() =>
      receipts.acknowledge({
        kind: "workspace",
        acknowledgementId: "invalid",
        throughSequence: 2,
        attention: [],
      }),
    ).toThrow("Unknown notification sequence");
    expect(receipts.includes(undefined)).toBe(false);
    expect(receipts.includes(0)).toBe(false);
    expect(receipts.includes(1)).toBe(false);
  });

  it("binds the observed event to attention without mutating a prior snapshot", () => {
    const receipts = new NotificationReceipts();
    receipts.issue({ agentId: "agent", timestamp: "first" });
    const prior = receipts.snapshot();
    receipts.issue({ agentId: "agent", timestamp: "second" });
    expect(prior.attentionEvents?.agent).toEqual({ sequence: 1, timestamp: "first" });
    expect(receipts.snapshot().attentionEvents?.agent).toEqual({
      sequence: 2,
      timestamp: "second",
    });
  });
});

it("does not turn a retried workspace receipt into another legacy backlog opening", () => {
  const receipts = new NotificationReceipts();
  receipts.acknowledge({
    kind: "workspace",
    acknowledgementId: "first",
    observedReadId: null,
    throughSequence: 0,
    attention: [],
  });
  receipts.acknowledge({
    kind: "workspace",
    acknowledgementId: "second",
    observedReadId: "first",
    throughSequence: 0,
    attention: [],
  });
  receipts.acknowledge({
    kind: "workspace",
    acknowledgementId: "first",
    observedReadId: null,
    throughSequence: 0,
    attention: [],
  });
  expect(receipts.snapshot().lastWorkspaceReadId).toBe("second");
});

it("shows the explicit intervention reason and routes to the escalating child's exact chat", () => {
  const payload = buildAgentAttentionNotificationPayload({
    reason: "finished",
    serverId: "host",
    workspaceId: "worker-workspace",
    agentId: "worker",
    workspaceName: "Worker checkout",
    attentionMessage: "Choose which account to use",
    assistantMessage: "Unrelated routine output",
  });
  expect(payload.body).toBe("Agent needs attention\nChoose which account to use");
  expect(payload.data).toMatchObject({
    serverId: "host",
    workspaceId: "worker-workspace",
    agentId: "worker",
  });
});
