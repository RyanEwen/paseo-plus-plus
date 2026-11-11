import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";
import type { HostMutations } from "@/runtime/host-runtime";
import { DaemonConnectionTestError } from "@/utils/daemon-connection-error";
import { saveImportedSshHost, type SshKeyImport } from "./ssh-key-import-model";

type ProbeSshHost = HostMutations["probeAndUpsertRemoteSshConnection"];
export type SavedSshHost = Awaited<ReturnType<ProbeSshHost>>;
type FormError =
  | {
      kind: "targetRequired" | "invalidTarget" | "targetNeedsUser" | "keyRequired" | "unableToSave";
    }
  | { kind: "connectionFailed" | "importFailed"; detail: string };

type SshTarget = ReturnType<typeof parseSshTransportUri>;

/**
 * Map a failed inspection or save to form copy. Native bridge errors (Android) and daemon
 * probe errors carry displayable text; anything else is reported generically.
 */
function toConnectionFormError(error: unknown, hasKeyImport: boolean): FormError {
  const hasDisplayableMessage =
    error instanceof Error && (hasKeyImport || error instanceof DaemonConnectionTestError);
  if (hasDisplayableMessage) {
    return { kind: "connectionFailed", detail: error.message };
  }
  return { kind: "unableToSave" };
}

export interface RemoteSshFormState {
  phase: "idle" | "importing" | "inspecting" | "saving";
  keyName: string | null;
  fingerprint: string | null;
  isPasswordVisible: boolean;
  error: FormError | null;
}

export interface RemoteSshFormSnapshot {
  keyImport: SshKeyImport | null;
  probeHost: ProbeSshHost;
}

export interface RemoteSshFormModel {
  getState: () => RemoteSshFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setTarget: (value: string) => void;
  setPassword: (value: string) => void;
  setPassphrase: (value: string) => void;
  togglePasswordVisibility: () => void;
  importKey: () => Promise<void>;
  submit: () => Promise<SavedSshHost | null>;
}

/** Own one open form's credentials and async lifetime. Closing fences late picker/probe results. */
export function openRemoteSshForm(snapshot: RemoteSshFormSnapshot): RemoteSshFormModel {
  let closed = false;
  let target = "";
  let password = "";
  let privateKey = "";
  let passphrase = "";
  const listeners = new Set<() => void>();
  let state: RemoteSshFormState = {
    phase: "idle",
    keyName: null,
    fingerprint: null,
    isPasswordVisible: false,
    error: null,
  };

  function publish(patch: Partial<RemoteSshFormState>) {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }

  /** The probe invokes this immediately before publishing the host, including on desktop. */
  function requireOpen() {
    if (closed) throw new Error("SSH setup was cancelled.");
  }

  /** Check the typed target and imported key. Publishes the first problem and returns null. */
  function validateInputs(): SshTarget | null {
    const trimmedTarget = target.trim();
    if (!trimmedTarget) {
      publish({ error: { kind: "targetRequired" } });
      return null;
    }
    let parsed: SshTarget;
    try {
      parsed = parseSshTransportUri(trimmedTarget);
    } catch {
      publish({ error: { kind: "invalidTarget" } });
      return null;
    }
    // Android has no SSH config to supply a username. Desktop's OpenSSH may have one.
    if (snapshot.keyImport && !parsed.host.includes("@")) {
      publish({ error: { kind: "targetNeedsUser" } });
      return null;
    }
    if (snapshot.keyImport && !privateKey) {
      publish({ error: { kind: "keyRequired" } });
      return null;
    }
    return parsed;
  }

  /** Ask the server for its fingerprint. Discovery signs nothing and saves nothing. */
  async function inspectServer(keyImport: SshKeyImport, parsed: SshTarget): Promise<void> {
    const observed = await keyImport.bridge.inspect(parsed, privateKey, passphrase);
    publish({ fingerprint: observed });
  }

  /**
   * Probe the daemon and publish the host. `commit` runs after a successful probe and before
   * the host is published; dismissal before that point cancels the save.
   */
  async function saveHost(input: {
    parsed: SshTarget;
    daemonPassword: string | undefined;
    commit?: () => Promise<void>;
  }) {
    requireOpen();
    return snapshot.probeHost({
      ...input.parsed,
      password: input.daemonPassword,
      beforeSave: async () => {
        requireOpen();
        // Once durable commit begins, finish publishing the host even if dismissed.
        // Rejecting afterward would leave committed credentials without a saved host.
        await input.commit?.();
      },
    });
  }

  /** Save with the approved imported key on Android, or through the system's OpenSSH. */
  async function saveApprovedHost(parsed: SshTarget, approvedFingerprint: string | null) {
    // Capture this attempt's inputs before awaiting. Closing clears the model's references.
    const daemonPassword = password === "" ? undefined : password;
    const keyImport = snapshot.keyImport;
    if (!keyImport || !approvedFingerprint) {
      return saveHost({ parsed, daemonPassword });
    }
    return saveImportedSshHost({
      bridge: keyImport.bridge,
      approved: {
        target: parsed,
        privateKey,
        passphrase,
        fingerprint: approvedFingerprint,
      },
      saveHost: (commit) => saveHost({ parsed, daemonPassword, commit }),
    });
  }

  /** Forget this attempt's secrets after a successful save. */
  function clearSecrets() {
    privateKey = "";
    passphrase = "";
    password = "";
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      target = "";
      password = "";
      privateKey = "";
      passphrase = "";
      listeners.clear();
    },
    setTarget(value) {
      if (closed || state.phase !== "idle") return;
      target = value;
      publish({ fingerprint: null });
    },
    setPassword(value) {
      if (!closed && state.phase === "idle") password = value;
    },
    setPassphrase(value) {
      if (closed || state.phase !== "idle") return;
      passphrase = value;
      publish({ fingerprint: null });
    },
    togglePasswordVisibility() {
      if (!closed && state.phase === "idle")
        publish({ isPasswordVisible: !state.isPasswordVisible });
    },
    async importKey() {
      if (closed || state.phase !== "idle" || !snapshot.keyImport) return;
      publish({ phase: "importing", error: null });
      try {
        const imported = await snapshot.keyImport.importPrivateKey();
        if (closed || !imported) return;
        privateKey = imported.text;
        publish({ keyName: imported.name, fingerprint: null });
      } catch (error) {
        publish({
          error:
            error instanceof Error
              ? { kind: "importFailed", detail: error.message }
              : { kind: "unableToSave" },
        });
      } finally {
        publish({ phase: "idle" });
      }
    },
    async submit() {
      if (closed || state.phase !== "idle") return null;
      const parsed = validateInputs();
      if (!parsed) return null;

      const keyImport = snapshot.keyImport;
      const needsFingerprintApproval = keyImport !== null && !state.fingerprint;
      publish({ phase: needsFingerprintApproval ? "inspecting" : "saving", error: null });
      try {
        if (needsFingerprintApproval) {
          await inspectServer(keyImport, parsed);
          return null;
        }
        const result = await saveApprovedHost(parsed, state.fingerprint);
        if (closed) return null;
        clearSecrets();
        return result;
      } catch (error) {
        publish({ error: toConnectionFormError(error, keyImport !== null) });
        return null;
      } finally {
        publish({ phase: "idle" });
      }
    },
  };
}
