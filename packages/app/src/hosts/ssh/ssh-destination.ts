import type { SshTransportTarget } from "@getpaseo/protocol/ssh-transport";
import { createRemoteSshHostConnection } from "@/types/host-connection";

/**
 * An SSH destination as saved connections, bridge URLs and native calls carry it. Unlike the
 * protocol's parsed target, `daemonPort` may be omitted and then means the default port.
 */
export type SshDestination = Omit<SshTransportTarget, "daemonPort"> &
  Partial<Pick<SshTransportTarget, "daemonPort">>;

/**
 * The id under which Android stores a destination's imported credentials. It equals the saved
 * connection's id, so removing a connection can erase its credentials by `connection.id`.
 */
export function sshCredentialId(destination: SshDestination): string {
  return createRemoteSshHostConnection(destination).id;
}
