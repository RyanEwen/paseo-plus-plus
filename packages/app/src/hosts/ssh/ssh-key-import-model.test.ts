import { describe, expect, it } from "vitest";
import {
  assertImportablePrivateKey,
  saveImportedSshHost,
  type SshKeyImportBridge,
} from "./ssh-key-import-model";

describe("assertImportablePrivateKey", () => {
  const UNSUPPORTED = "This key format is not supported. Use an OpenSSH or PEM private key.";
  const PUBLIC_KEY = "Choose a private key, not a public key.";

  it("accepts OpenSSH and PEM private keys", () => {
    expect(() =>
      assertImportablePrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----\nabc"),
    ).not.toThrow();
    expect(() => assertImportablePrivateKey("-----BEGIN RSA PRIVATE KEY-----\nabc")).not.toThrow();
  });

  it("names the unsupported format for a PuTTY key", () => {
    expect(() =>
      assertImportablePrivateKey("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none"),
    ).toThrow(UNSUPPORTED);
  });

  it("identifies OpenSSH and PEM public keys", () => {
    expect(() => assertImportablePrivateKey("ssh-ed25519 AAAA deploy@example.com")).toThrow(
      PUBLIC_KEY,
    );
    expect(() => assertImportablePrivateKey("-----BEGIN PUBLIC KEY-----\nabc")).toThrow(PUBLIC_KEY);
  });
});

describe("saveImportedSshHost", () => {
  const approved = {
    target: { host: "deploy@example.com" },
    privateKey: "test-only-private-key",
    passphrase: "test-passphrase",
    fingerprint: "SHA256:test",
  };
  function createBridge(events: string[], failCommit = false): SshKeyImportBridge {
    return {
      inspect: async () => approved.fingerprint,
      stage: async () => {
        events.push("stage");
      },
      commit: async () => {
        events.push("commit");
        if (failCommit) throw new Error("Secure storage unavailable");
      },
      discard: async () => {
        events.push("discard");
      },
    };
  }
  it("stores credentials after the probe and before saving the host", async () => {
    const events: string[] = [];
    const result = await saveImportedSshHost({
      bridge: createBridge(events),
      approved,
      saveHost: async (beforeSave) => {
        events.push("probe");
        await beforeSave();
        events.push("save-host");
        return "saved";
      },
    });
    expect(result).toBe("saved");
    expect(events).toEqual(["stage", "probe", "commit", "save-host", "discard"]);
  });
  it("discards a failed probe without replacing saved credentials", async () => {
    const events: string[] = [];
    await expect(
      saveImportedSshHost({
        bridge: createBridge(events),
        approved,
        saveHost: async () => {
          events.push("probe");
          throw new Error("Fingerprint changed");
        },
      }),
    ).rejects.toThrow("Fingerprint changed");
    expect(events).toEqual(["stage", "probe", "discard"]);
  });
  it("does not save the host when secure storage fails", async () => {
    const events: string[] = [];
    await expect(
      saveImportedSshHost({
        bridge: createBridge(events, true),
        approved,
        saveHost: async (beforeSave) => {
          events.push("probe");
          await beforeSave();
          events.push("save-host");
        },
      }),
    ).rejects.toThrow("Secure storage unavailable");
    expect(events).toEqual(["stage", "probe", "commit", "discard"]);
  });
});
