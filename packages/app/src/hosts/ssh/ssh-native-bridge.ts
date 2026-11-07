import type { EventSubscription } from "expo-modules-core";
import type { BridgeDaemonTransportEvent } from "@/hosts/daemon-transport-bridge";
import type { SshDestination } from "./ssh-destination";
import type { SshKeyImportBridge } from "./ssh-key-import-model";

/** The `PaseoSsh` Expo module as JavaScript sees it. Every rejection uses Expo's envelope. */
export interface SshNativeModule extends SshKeyImportBridge {
  remove(id: string): Promise<void>;
  open(sessionId: string, credentialId: string, target: SshDestination): Promise<void>;
  send(sessionId: string, text: string | null, binary: string | null): Promise<void>;
  close(sessionId: string): Promise<void>;
  addListener(
    name: "transportEvent",
    handler: (event: BridgeDaemonTransportEvent) => void,
  ): EventSubscription;
}

/**
 * User-facing copy for the codes thrown by `SshException.kt`. Keep the two lists in sync.
 * The native message is not used: Expo prefixes it with the module and function name.
 */
const SSH_ERROR_MESSAGES = {
  ERR_SSH_INVALID_TARGET: "Enter ssh://user@hostname with an explicit username.",
  ERR_SSH_KEY_TOO_LARGE: "Choose a private key smaller than 64 KiB.",
  ERR_SSH_KEY_UNREADABLE: "Unable to read the private key. Check its format and passphrase.",
  ERR_SSH_UNREACHABLE: "Unable to reach the SSH server. Check the hostname and port.",
  ERR_SSH_INVALID_CREDENTIALS: "Invalid SSH credentials.",
  ERR_SSH_IMPORT_EXPIRED: "SSH key import expired. Import the key again.",
  ERR_SSH_KEY_MISSING: "Import a private key for this SSH host on this device.",
  ERR_SSH_SESSION_CLOSED: "SSH session is closed.",
} as const;

export type SshBridgeErrorCode = keyof typeof SSH_ERROR_MESSAGES;

/** Shown for any native failure without a known code, so Java class names never reach the UI. */
const UNEXPECTED_SSH_ERROR_MESSAGE = "The SSH bridge failed unexpectedly. Try again.";

/** A native SSH failure with user-facing copy. `code` is null for unexpected failures. */
export class SshBridgeError extends Error {
  readonly code: SshBridgeErrorCode | null;

  constructor(code: SshBridgeErrorCode | null) {
    super(code === null ? UNEXPECTED_SSH_ERROR_MESSAGE : SSH_ERROR_MESSAGES[code]);
    this.name = "SshBridgeError";
    this.code = code;
  }
}

function isSshBridgeErrorCode(code: unknown): code is SshBridgeErrorCode {
  return typeof code === "string" && Object.hasOwn(SSH_ERROR_MESSAGES, code);
}

/** Translate one rejection from the native module. This is the only reader of Expo's envelope. */
export function toSshBridgeError(error: unknown): SshBridgeError {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
  return new SshBridgeError(isSshBridgeErrorCode(code) ? code : null);
}

/** Run one native call and replace its rejection with a typed, displayable error. */
async function callNative<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toSshBridgeError(error);
  }
}

/**
 * Wrap the native module so every caller (key import, host removal, tunnel setup and sends)
 * receives `SshBridgeError` instead of Expo's "Call to function ... has been rejected" text.
 */
export function createSshNativeBridge(native: SshNativeModule): SshNativeModule {
  return {
    inspect: (target, privateKey, passphrase) =>
      callNative(() => native.inspect(target, privateKey, passphrase)),
    stage: (id, target, privateKey, passphrase, fingerprint) =>
      callNative(() => native.stage(id, target, privateKey, passphrase, fingerprint)),
    commit: (id) => callNative(() => native.commit(id)),
    discard: (id) => callNative(() => native.discard(id)),
    remove: (id) => callNative(() => native.remove(id)),
    open: (sessionId, credentialId, target) =>
      callNative(() => native.open(sessionId, credentialId, target)),
    send: (sessionId, text, binary) => callNative(() => native.send(sessionId, text, binary)),
    close: (sessionId) => callNative(() => native.close(sessionId)),
    addListener: (name, handler) => native.addListener(name, handler),
  };
}
