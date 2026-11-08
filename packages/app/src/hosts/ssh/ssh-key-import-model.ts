import { i18n } from "@/i18n/i18next";
import { sshCredentialId, type SshDestination } from "./ssh-destination";

export interface ImportedPrivateKey {
  name: string;
  text: string;
}

/**
 * Reject a picked file that is not an OpenSSH or PEM private key. A public key gets its own
 * message because picking `id_ed25519.pub` by mistake is the common case.
 * @throws Error with displayable copy.
 */
export function assertImportablePrivateKey(text: string): void {
  if (text.includes("PRIVATE KEY")) return;

  const isPublicKey = text.includes("PUBLIC KEY") || /^\s*(ssh|ecdsa|sk)-/u.test(text);
  if (isPublicKey) throw new Error("Choose a private key, not a public key.");

  throw new Error(i18n.t("sshErrors.keyFormatUnsupported"));
}

export interface SshKeyImportBridge {
  inspect(target: SshDestination, privateKey: string, passphrase: string): Promise<string>;
  stage(
    id: string,
    target: SshDestination,
    privateKey: string,
    passphrase: string,
    fingerprint: string,
  ): Promise<void>;
  commit(id: string): Promise<void>;
  discard(id: string): Promise<void>;
}

/** Android's key import capability: the native bridge plus the system file picker. */
export interface SshKeyImport {
  bridge: SshKeyImportBridge;
  importPrivateKey: () => Promise<ImportedPrivateKey | null>;
}

export interface ApprovedSshKey {
  target: SshDestination;
  privateKey: string;
  passphrase: string;
  fingerprint: string;
}

interface SshImportOperation<T> {
  bridge: SshKeyImportBridge;
  approved: ApprovedSshKey;
  saveHost: (beforeSave: () => Promise<void>) => Promise<T>;
}

const importTails = new Map<string, Promise<void>>();

/**
 * Serialize each destination's complete import transaction, including discard. A dismissed
 * form's pending probe must not erase or overwrite a new form's staged credentials.
 */
export async function saveImportedSshHost<T>({
  bridge,
  approved,
  saveHost,
}: SshImportOperation<T>): Promise<T> {
  const id = sshCredentialId(approved.target);
  const previous = importTails.get(id);
  let release = () => {};
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  importTails.set(id, completed);
  await previous;
  try {
    await bridge.stage(
      id,
      approved.target,
      approved.privateKey,
      approved.passphrase,
      approved.fingerprint,
    );
    try {
      return await saveHost(() => bridge.commit(id));
    } finally {
      await bridge.discard(id);
    }
  } finally {
    release();
    if (importTails.get(id) === completed) importTails.delete(id);
  }
}
