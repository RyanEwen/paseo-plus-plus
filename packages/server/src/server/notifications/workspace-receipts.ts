import {
  NotificationReceipts,
  type NotificationAcknowledgement,
} from "@getpaseo/protocol/notification-receipts";
import type { WorkspaceRegistry } from "../workspace-registry.js";

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

  async acknowledge(
    workspaceId: string,
    acknowledgement: NotificationAcknowledgement,
  ): Promise<void> {
    const updated = await this.workspaces.update(workspaceId, (workspace) => {
      if (workspace.archivedAt) throw new Error("Workspace is archived");
      const receipts = new NotificationReceipts(workspace.notificationReceipts);
      receipts.acknowledge(acknowledgement);
      return { ...workspace, notificationReceipts: receipts.snapshot() };
    });
    if (!updated) throw new Error("Workspace not found");
    await this.publish(workspaceId);
  }
}
