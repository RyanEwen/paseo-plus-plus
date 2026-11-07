import type { HostProfile } from "@/types/host-connection";

/** The name shown for a host: its label, or its stable server ID when the label is blank. */
export function hostDisplayLabel(host: Pick<HostProfile, "serverId" | "label">): string {
  return host.label.trim() || host.serverId;
}
