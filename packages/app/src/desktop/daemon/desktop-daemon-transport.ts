import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client";
import { createBridgeDaemonTransportFactory } from "@/hosts/transport-bridge/transport";
import {
  defaultLocalDaemonTransportRpc,
  type LocalDaemonTransportRpc,
} from "./local-daemon-transport-rpc";

// The transport lifecycle moved to hosts/transport-bridge so Android's native SSH bridge can
// share it. These names stay so upstream call sites and tests keep working unchanged.
export { buildBridgeDaemonTransportUrl as buildDesktopDaemonTransportUrl } from "@/hosts/transport-bridge/transport";

/** Connect desktop IPC to the shared daemon transport lifecycle. Keeps upstream's signature. */
export function createDesktopDaemonTransportFactory(
  rpc: LocalDaemonTransportRpc = defaultLocalDaemonTransportRpc,
): DaemonTransportFactory | null {
  return createBridgeDaemonTransportFactory(rpc);
}
