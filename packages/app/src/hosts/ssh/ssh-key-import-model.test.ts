import { describe, expect, it } from "vitest";
import { saveImportedSshHost, type SshKeyImportBridge } from "./ssh-key-import-model";

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
