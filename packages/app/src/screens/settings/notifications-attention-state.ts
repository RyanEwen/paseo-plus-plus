import { isAgentAwareAttentionEnabled } from "@getpaseo/protocol/agent-attention";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

export type AttentionControlHint =
  | { key: "settings.notifications.agentAwareHint"; host: string }
  | { key: "workspace.terminal.hostDisconnected" }
  | { key: "settings.notifications.updateHost" }
  | { key: "settings.notifications.readOnly" }
  | { key: "settings.notifications.saving" };

export interface AttentionControlState {
  /** False while the host's preference is still loading, so the switch never flashes a default. */
  visible: boolean;
  value: boolean;
  disabled: boolean;
  hint: AttentionControlHint;
}

/**
 * Presentation of the host-owned Agent-aware attention switch.
 *
 * The first unmet requirement explains why the switch is disabled: connection, then host
 * support, then management permission. A pending save says so in the hint.
 */
export function resolveAttentionControlState(input: {
  host: string;
  connected: boolean;
  supported: boolean;
  writable: boolean;
  config: MutableDaemonConfig | null;
  isLoading: boolean;
  loadFailed: boolean;
  isPending: boolean;
}): AttentionControlState {
  const loading = input.connected && input.supported && !input.config && !input.loadFailed;
  const editable = input.connected && input.supported && input.writable && input.config !== null;
  return {
    visible: !loading,
    // An unreachable or older host has no stored preference to show; the default is enabled.
    value: input.config ? isAgentAwareAttentionEnabled(input.config) : true,
    disabled: !editable || input.isLoading || input.loadFailed || input.isPending,
    hint: resolveHint(input),
  };
}

function resolveHint(input: {
  host: string;
  connected: boolean;
  supported: boolean;
  writable: boolean;
  isPending: boolean;
}): AttentionControlHint {
  if (!input.connected) {
    return { key: "workspace.terminal.hostDisconnected" };
  }
  if (!input.supported) {
    return { key: "settings.notifications.updateHost" };
  }
  if (!input.writable) {
    return { key: "settings.notifications.readOnly" };
  }
  if (input.isPending) {
    return { key: "settings.notifications.saving" };
  }
  return { key: "settings.notifications.agentAwareHint", host: input.host };
}
