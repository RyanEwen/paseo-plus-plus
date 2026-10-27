import type { WorkspaceNotificationReceipts } from "@getpaseo/protocol/notification-receipts";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { notificationReceiptDevice } from "./receipt-device";
import { WorkspaceNotificationSynchronizer } from "./workspace-receipts";

interface ObservedAttention {
  agentId: string;
  timestamp: string;
}
interface ActiveWorkspace {
  workspaceId: string;
  snapshot: WorkspaceNotificationReceipts;
  attention: ObservedAttention[];
  lease: symbol;
  release: (() => void) | null;
}

/** Bind the receipt domain to existing host subscriptions and foreground workspace leases. */
class WorkspaceNotificationRuntime {
  private readonly hosts = new Map<string, WorkspaceNotificationSynchronizer>();
  private readonly active = new Map<string, ActiveWorkspace>();

  start(serverId: string, client: DaemonClient): () => void {
    const report = (error: unknown) =>
      console.warn("[notifications] Workspace acknowledgement failed", { serverId, error });
    const sync = new WorkspaceNotificationSynchronizer({
      serverId,
      device: notificationReceiptDevice,
      storage: AsyncStorage,
      acknowledge: (workspaceId, notification) =>
        client.acknowledgeWorkspaceNotifications(workspaceId, notification),
      resolveAgentWorkspace: async (agentId) =>
        (await client.fetchAgent(agentId))?.agent.workspaceId ?? null,
      attention: (workspaceId) => this.attention(serverId, workspaceId),
      report,
      newId: () => globalThis.crypto.randomUUID(),
    });
    this.hosts.set(serverId, sync);
    const active = this.active.get(serverId);
    if (active) active.release = sync.open(active.workspaceId, active.snapshot, active.attention);
    sync.setConnected(client.isConnected);
    const connection = client.subscribeConnectionStatus((state) =>
      sync.setConnected(state.status === "connected"),
    );
    const workspaces = client.observeWorkspaces({ includeBackground: true });
    const stopObserving = workspaces.subscribe({
      snapshot: (snapshot) => sync.accept(snapshot.entries),
      update: (message) => {
        if (message.type === "workspace_update" && message.payload.kind === "upsert")
          sync.accept([message.payload.workspace]);
      },
      error: report,
    });
    void sync.start().catch(report);
    return () => {
      connection();
      stopObserving();
      void workspaces.release().catch(report);
      sync.dispose();
      if (this.hosts.get(serverId) === sync) this.hosts.delete(serverId);
    };
  }

  /** Retained screens cannot release a newer selected workspace's ownership. */
  open(serverId: string, workspaceId: string, snapshot: WorkspaceNotificationReceipts): () => void {
    const lease = Symbol("foreground-workspace");
    const previous = this.active.get(serverId);
    previous?.release?.();
    const attention = this.attention(serverId, workspaceId);
    const active: ActiveWorkspace = {
      workspaceId,
      snapshot,
      attention,
      lease,
      release: this.hosts.get(serverId)?.open(workspaceId, snapshot, attention) ?? null,
    };
    this.active.set(serverId, active);
    return () => {
      if (this.active.get(serverId)?.lease !== lease) return;
      active.release?.();
      this.active.delete(serverId);
    };
  }

  /** Capture observed attention with the activation, before storage or subscriptions can await. */
  private attention(serverId: string, workspaceId: string): ObservedAttention[] {
    const result: ObservedAttention[] = [];
    for (const agent of useSessionStore.getState().sessions[serverId]?.agents.values() ?? []) {
      if (
        agent.workspaceId === workspaceId &&
        agent.requiresAttention &&
        agent.attentionTimestamp
      ) {
        result.push({ agentId: agent.id, timestamp: agent.attentionTimestamp.toISOString() });
      }
    }
    return result;
  }

  async markRead(serverId: string, workspaceId: string): Promise<void> {
    const sync = this.hosts.get(serverId);
    if (!sync) throw new Error("Waiting for workspace notification sync");
    await sync.markRead(workspaceId);
  }

  isAcknowledged(data: Record<string, unknown> | undefined): boolean {
    return (
      typeof data?.serverId === "string" &&
      this.hosts.get(data.serverId)?.isAcknowledged(data) === true
    );
  }

  resume(serverId: string): void {
    const sync = this.hosts.get(serverId);
    if (sync)
      void sync
        .flush()
        .catch((error) => console.warn("[notifications] Resume reconciliation failed", error));
  }
}
export const workspaceNotificationRuntime = new WorkspaceNotificationRuntime();
