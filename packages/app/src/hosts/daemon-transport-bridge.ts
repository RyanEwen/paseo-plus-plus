import type { SshDestination } from "./ssh/ssh-destination";

export interface LocalTransportTarget {
  [key: string]: unknown;
  transportType: "socket" | "pipe";
  transportPath: string;
}
export type SshBridgeTransportTarget = SshDestination & {
  [key: string]: unknown;
  transportType: "ssh";
};
export type BridgeDaemonTransportTarget = LocalTransportTarget | SshBridgeTransportTarget;
export interface OpenBridgeTransportSessionInput {
  [key: string]: unknown;
  sessionId: string;
  target: BridgeDaemonTransportTarget;
}
export interface BridgeDaemonTransportEvent {
  sessionId: string;
  kind: "open" | "message" | "close" | "error";
  text?: string | null;
  binaryBase64?: string | null;
  code?: number | null;
  reason?: string | null;
  error?: string | null;
}
export interface DaemonTransportBridge {
  openSession(input: OpenBridgeTransportSessionInput): Promise<void>;
  listenToEvents(handler: (event: BridgeDaemonTransportEvent) => void): Promise<() => void>;
  sendMessage(input: { sessionId: string; text?: string; binaryBase64?: string }): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}
