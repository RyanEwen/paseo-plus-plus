import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema } from "./messages.js";
import { NotificationReceipts } from "./notification-receipts.js";

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

  it("forgets settled attention events only for agents that no longer exist", () => {
    const receipts = new NotificationReceipts();
    receipts.issue({ agentId: "gone", timestamp: "first" });
    receipts.issue({ agentId: "live", timestamp: "second" });
    receipts.issue({ agentId: "gone-dismissed", timestamp: "third" });
    receipts.issue({ agentId: "gone-unread", timestamp: "fourth" });
    receipts.acknowledge({
      kind: "workspace",
      acknowledgementId: "open",
      throughSequence: 2,
      attention: [],
    });
    receipts.acknowledge({ kind: "event", acknowledgementId: "swipe", sequence: 3, attention: [] });

    receipts.pruneAttention(new Set(["live"]));

    expect(receipts.snapshot().attentionEvents).toEqual({
      live: { sequence: 2, timestamp: "second" },
      "gone-unread": { sequence: 4, timestamp: "fourth" },
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
});
