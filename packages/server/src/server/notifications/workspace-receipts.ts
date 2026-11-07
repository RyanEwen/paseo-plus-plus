import {
  NotificationReceipts,
  NotificationRejectedError,
  type NotificationAcknowledgement,
} from "@getpaseo/protocol/notification-receipts";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { registerForkCapability } from "../fork-capabilities.js";

// COMPAT(workspaceNotificationReceipts): added after v0.12.0-beta.3; keep advertising after the
// client gate is removed, so newer apps can still detect hosts that sync receipts.
registerForkCapability("workspaceNotificationReceipts");

/** Persist delivery receipts with their workspace and publish only committed registry state. */
export class WorkspaceNotificationReceipts {
  constructor(
    private readonly workspaces: WorkspaceRegistry,
    private readonly publish: (workspaceId: string) => Promise<void>,
  ) {}

  async issue(
    workspaceId: string,
    attention?: { agentId: string; timestamp: string },
  ): Promise<number | undefined> {
    let sequence: number | undefined;
    const updated = await this.workspaces.update(workspaceId, (workspace) => {
      const receipts = new NotificationReceipts(workspace.notificationReceipts);
      sequence = receipts.issue(attention);
      return { ...workspace, notificationReceipts: receipts.snapshot() };
    });
    if (updated) await this.publish(workspaceId);
    return sequence;
  }

  /**
   * Commit an acknowledgement and publish the committed receipts.
   *
   * @param liveAgentIds agents that still exist and are not archived; settled attention events of
   *   every other agent are forgotten in the same write.
   * @throws NotificationRejectedError when the workspace is archived or gone, or the receipt names
   *   a sequence this workspace never issued.
   */
  async acknowledge(
    workspaceId: string,
    acknowledgement: NotificationAcknowledgement,
    liveAgentIds: ReadonlySet<string>,
  ): Promise<void> {
    const updated = await this.workspaces.update(workspaceId, (workspace) => {
      if (workspace.archivedAt) {
        throw new NotificationRejectedError("workspace_unavailable", "Workspace is archived");
      }
      const receipts = new NotificationReceipts(workspace.notificationReceipts);
      receipts.acknowledge(acknowledgement);
      receipts.pruneAttention(liveAgentIds);
      return { ...workspace, notificationReceipts: receipts.snapshot() };
    });
    if (!updated) {
      throw new NotificationRejectedError("workspace_unavailable", "Workspace not found");
    }
    await this.publish(workspaceId);
  }
}
