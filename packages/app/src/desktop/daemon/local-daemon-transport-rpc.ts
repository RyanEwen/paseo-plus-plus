import {
  closeLocalTransportSession,
  listenToLocalTransportEvents,
  openLocalTransportSession,
  sendLocalTransportMessage,
} from "./desktop-daemon";

import type { DaemonTransportBridge as LocalDaemonTransportRpc } from "@/hosts/transport-bridge/types";

// Upstream names for the shared bridge types, kept so desktop call sites stay unchanged.
export type {
  BridgeDaemonTransportEvent as LocalDaemonTransportEvent,
  DaemonTransportBridge as LocalDaemonTransportRpc,
} from "@/hosts/transport-bridge/types";

export const defaultLocalDaemonTransportRpc: LocalDaemonTransportRpc = {
  openSession: openLocalTransportSession,
  listenToEvents: listenToLocalTransportEvents,
  sendMessage: sendLocalTransportMessage,
  closeSession: closeLocalTransportSession,
};
