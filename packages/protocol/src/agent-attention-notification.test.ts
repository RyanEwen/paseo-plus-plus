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
