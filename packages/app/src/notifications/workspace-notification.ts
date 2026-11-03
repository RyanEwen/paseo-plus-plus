import type { OsNotificationPayload } from "@/utils/os-notifications";

interface WorkspaceNotificationPorts {
  getIcon(data: Record<string, unknown> | undefined): Promise<string | undefined>;
  send(payload: OsNotificationPayload): Promise<boolean>;
}

const defaultPorts: WorkspaceNotificationPorts = {
  async getIcon(data) {
    const { getNotificationProjectIcon } = await import("./project-icon");
    return getNotificationProjectIcon(data);
  },
  async send(payload) {
    const { sendOsNotification } = await import("@/utils/os-notifications");
    const { workspaceNotificationRuntime } = await import("./workspace-receipts-runtime");
    if (workspaceNotificationRuntime.isAcknowledged(payload.data)) return true;
    const sent = await sendOsNotification(payload);
    if (sent && typeof payload.data?.serverId === "string")
      workspaceNotificationRuntime.resume(payload.data.serverId);
    return sent;
  },
};

/** Attach project identity to workspace alerts before handing off to the OS adapter. */
export async function sendWorkspaceOsNotification(
  payload: OsNotificationPayload,
  ports: WorkspaceNotificationPorts = defaultPorts,
): Promise<boolean> {
  // Icon enrichment must never hold up a permission request or completion alert.
  // The lookup may finish later and warm the existing project-icon cache.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let icon: string | undefined;
  try {
    icon = await Promise.race([
      ports.getIcon(payload.data),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 500);
      }),
    ]);
  } catch {
    // Icon acquisition is optional metadata, including when module loading fails.
  } finally {
    clearTimeout(timer);
  }
  return ports.send({ ...payload, ...(icon ? { icon } : {}) });
}
