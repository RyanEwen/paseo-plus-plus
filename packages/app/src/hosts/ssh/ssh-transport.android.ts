import { requireOptionalNativeModule } from "expo-modules-core";
import { createBridgeDaemonTransportFactory } from "@/hosts/bridge-daemon-transport";
import { sshCredentialId } from "./ssh-destination";
import { importPrivateKey } from "./import-private-key";
import type { SshKeyImport } from "./ssh-key-import-model";
import { createSshNativeBridge, type SshNativeModule } from "./ssh-native-bridge";

const nativeModule = requireOptionalNativeModule<SshNativeModule>("PaseoSsh");
// Every native call goes through the bridge so rejections carry displayable copy.
const native = nativeModule ? createSshNativeBridge(nativeModule) : null;
// One stable value per process, so the form can take it as a prop without re-rendering.
const keyImport: SshKeyImport | null = native ? { bridge: native, importPrivateKey } : null;

export const isSshAvailable = () => native !== null;

/** Key import is available whenever this build includes the native SSH module. */
export function getSshKeyImport(): SshKeyImport | null {
  return keyImport;
}

/** Select Android's native SSH bridge for probes and ordinary host reconnection alike. */
export function createSshTransportFactory() {
  if (!native) return null;
  const bridge = native;
  return createBridgeDaemonTransportFactory({
    openSession: async ({ sessionId, target }) => {
      if (target.transportType !== "ssh")
        throw new Error("Android only supports SSH through this bridge.");
      await bridge.open(sessionId, sshCredentialId(target), target);
    },
    listenToEvents: async (handler) => {
      const subscription = bridge.addListener("transportEvent", handler);
      return () => subscription.remove();
    },
    sendMessage: ({ sessionId, text, binaryBase64 }) =>
      bridge.send(sessionId, text ?? null, binaryBase64 ?? null),
    closeSession: (id) => bridge.close(id),
  });
}

/** Erase imported secrets when the corresponding connection leaves the host registry. */
export async function removeSshCredentials(id: string): Promise<void> {
  await native?.remove(id);
}
