import type { WorkspaceNotificationReceipts } from "@getpaseo/protocol/notification-receipts";
import type { LegacyNotification } from "./receipt-document";

/** A notification currently shown by this device. */
interface PresentedNotification {
  identifier: string;
  data?: Record<string, unknown>;
}

interface StartupCaptureInput {
  presented: readonly PresentedNotification[];
  serverId: string;
  /** Legacy notifications already captured by an earlier start. */
  known: readonly LegacyNotification[];
  /** The workspace's current read identity, or undefined until its receipts arrive. */
  readIdFor(workspaceId: string): string | null | undefined;
}

/**
 * Capture this host's own notifications that were shown before receipts existed (they carry no
 * receipt sequence). Only notifications present at startup are captured; later unidentified
 * alerts are left alone, so they are never cleared as part of that backlog.
 */
export function captureStartupLegacy(input: StartupCaptureInput): LegacyNotification[] {
  const existing = new Set(input.known.map((item) => item.identifier));
  const captured: LegacyNotification[] = [];
  for (const item of input.presented) {
    const ownedByHost = item.data?.serverId === input.serverId;
    const hasReceipt = typeof item.data?.notificationSequence === "number";
    if (!ownedByHost || hasReceipt || existing.has(item.identifier)) continue;
    const workspaceId = typeof item.data?.workspaceId === "string" ? item.data.workspaceId : null;
    captured.push({
      ...item,
      workspaceId,
      capturedReadId: workspaceId ? input.readIdFor(workspaceId) : undefined,
    });
  }
  return captured;
}

/** Bind the first-seen read identity to a workspace's captured notifications that lack one. */
export function bindLegacyReadIds(
  legacy: readonly LegacyNotification[],
  workspaceId: string,
  readId: string | null,
): void {
  for (const item of legacy) {
    if (item.workspaceId === workspaceId && item.capturedReadId === undefined) {
      item.capturedReadId = readId;
    }
  }
}

interface LegacyReconcileInput {
  legacy: readonly LegacyNotification[];
  connected: boolean;
  snapshots: ReadonlyMap<string, WorkspaceNotificationReceipts>;
  /** Each workspace's read identity when its receipts first arrived on this device. */
  initialReadIds: ReadonlyMap<string, string | null>;
  resolveAgentWorkspace(agentId: string): Promise<string | null>;
  dismiss(identifier: string): Promise<void>;
  /** Drop a dismissed notification from the captured set. */
  remove(identifier: string): void;
  persist(): Promise<void>;
}

/**
 * Resolve missing workspace ownership through the host's agent record, then dismiss each captured
 * notification once its workspace has been read since capture. Unresolved ownership is retained
 * for a later lookup; a notification disappearing is never taken as a manual dismissal.
 */
export async function reconcileLegacyNotifications(input: LegacyReconcileInput): Promise<void> {
  for (const legacy of input.legacy) {
    const agentId = legacy.data?.agentId;
    if (!legacy.workspaceId && input.connected && typeof agentId === "string") {
      legacy.workspaceId = await input.resolveAgentWorkspace(agentId);
      if (legacy.workspaceId) {
        if (legacy.capturedReadId === undefined && input.snapshots.has(legacy.workspaceId)) {
          legacy.capturedReadId = input.initialReadIds.get(legacy.workspaceId) ?? null;
        }
        await input.persist();
      }
    }
    const snapshot = legacy.workspaceId ? input.snapshots.get(legacy.workspaceId) : null;
    const readSinceCapture =
      legacy.capturedReadId !== undefined &&
      Boolean(snapshot?.lastWorkspaceReadId) &&
      snapshot?.lastWorkspaceReadId !== legacy.capturedReadId;
    if (readSinceCapture) {
      await input.dismiss(legacy.identifier);
      input.remove(legacy.identifier);
      await input.persist();
    }
  }
}
