import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { WorkspaceNotificationReceipts } from "./workspace-receipts.js";

test("workspace notification receipts persist event frontiers and publish committed snapshots", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-workspace-receipts-"));
  try {
    const file = path.join(directory, "workspaces.json");
    const registry = new FileBackedWorkspaceRegistry(file, createTestLogger());
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "receipt-workspace",
        projectId: "project",
        cwd: directory,
        kind: "directory",
        displayName: "Receipts",
        createdAt: "2026-10-21T12:00:00.000Z",
        updatedAt: "2026-10-21T12:00:00.000Z",
      }),
    );
    const published: number[] = [];
    const receipts = new WorkspaceNotificationReceipts(registry, async (id) => {
      published.push((await registry.get(id))!.notificationReceipts!.latestSequence);
    });
    expect(
      await receipts.issue("receipt-workspace", { agentId: "agent", timestamp: "observed" }),
    ).toBe(1);
    expect(await receipts.issue("receipt-workspace")).toBe(2);
    await receipts.acknowledge(
      "receipt-workspace",
      {
        kind: "event",
        acknowledgementId: "swipe",
        sequence: 2,
        attention: [],
      },
      new Set(["agent"]),
    );
    const restarted = new FileBackedWorkspaceRegistry(file, createTestLogger());
    expect((await restarted.get("receipt-workspace"))?.notificationReceipts).toMatchObject({
      latestSequence: 2,
      acknowledgedThrough: 0,
      dismissedSequences: [2],
    });
    await receipts.acknowledge(
      "receipt-workspace",
      {
        kind: "workspace",
        acknowledgementId: "open",
        throughSequence: 1,
        attention: [],
      },
      new Set(["agent"]),
    );
    expect((await registry.get("receipt-workspace"))?.notificationReceipts).toMatchObject({
      latestSequence: 2,
      acknowledgedThrough: 2,
      dismissedSequences: [],
      lastWorkspaceReadId: "open",
    });
    await expect(
      receipts.acknowledge(
        "receipt-workspace",
        {
          kind: "event",
          acknowledgementId: "future",
          sequence: 3,
          attention: [],
        },
        new Set(["agent"]),
      ),
    ).rejects.toThrow("Unknown notification sequence");
    expect(published).toEqual([1, 2, 2, 2]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("acknowledging forgets settled attention events of agents that no longer exist", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-workspace-receipt-pruning-"));
  try {
    const registry = new FileBackedWorkspaceRegistry(
      path.join(directory, "workspaces.json"),
      createTestLogger(),
    );
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace",
        projectId: "project",
        cwd: directory,
        kind: "directory",
        displayName: "Receipts",
        createdAt: "2026-10-21T12:00:00.000Z",
        updatedAt: "2026-10-21T12:00:00.000Z",
      }),
    );
    const receipts = new WorkspaceNotificationReceipts(registry, async () => {});
    await receipts.issue("workspace", { agentId: "archived", timestamp: "first" });
    await receipts.issue("workspace", { agentId: "live", timestamp: "second" });
    await receipts.issue("workspace", { agentId: "deleted-unread", timestamp: "third" });

    await receipts.acknowledge(
      "workspace",
      { kind: "workspace", acknowledgementId: "open", throughSequence: 2, attention: [] },
      new Set(["live"]),
    );

    // Unacknowledged events stay, whoever raised them; acknowledged ones stay for live agents.
    expect((await registry.get("workspace"))?.notificationReceipts?.attentionEvents).toEqual({
      live: { sequence: 2, timestamp: "second" },
      "deleted-unread": { sequence: 3, timestamp: "third" },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
