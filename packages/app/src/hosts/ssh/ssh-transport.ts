import type { SshKeyImport } from "./ssh-key-import-model";
import { getIsElectron } from "@/constants/platform";
import { createDesktopDaemonTransportFactory } from "@/desktop/daemon/desktop-daemon-transport";

export const isSshAvailable = getIsElectron;
export const createSshTransportFactory = createDesktopDaemonTransportFactory;
/** Mobile credentials are device-local; other platforms own their credentials outside Paseo. */
export async function removeSshCredentials(_id: string): Promise<void> {}

/** Only Android imports SSH keys; desktop authenticates through the user's OpenSSH. */
export function getSshKeyImport(): SshKeyImport | null {
  return null;
}
