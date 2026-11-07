import { describe, expect, it } from "vitest";
import { DaemonConnectionTestError } from "@/utils/daemon-connection-error";
import {
  openRemoteSshForm,
  type RemoteSshFormModel,
  type SavedSshHost,
} from "./remote-ssh-form-model";
import { SshBridgeError } from "./ssh-native-bridge";
import { createTestSshKeyImport, type TestSshKeyImport } from "./test-ssh-key-import";

type ProbeInput = Parameters<Parameters<typeof openRemoteSshForm>[0]["probeHost"]>[0];

const SAVED_HOST = {
  profile: { serverId: "srv_ssh" },
  serverId: "srv_ssh",
  hostname: "server",
} as unknown as SavedSshHost;

/** A host registry probe that records its inputs and runs `beforeSave` like the real one. */
function createTestProbe(options: { failure?: unknown } = {}) {
  const inputs: ProbeInput[] = [];
  async function probeHost(input: ProbeInput): Promise<SavedSshHost> {
    inputs.push(input);
    if (options.failure !== undefined) throw options.failure;
    await input.beforeSave?.();
    return SAVED_HOST;
  }
  return { inputs, probeHost };
}

/** A probe that succeeds only when the test calls `finish`, then runs `beforeSave`. */
function createHeldProbe() {
  let finishProbe: (() => void) | null = null;

  function waitForFinish() {
    return new Promise<void>((resolve) => {
      finishProbe = resolve;
    });
  }

  async function probeHost(input: ProbeInput): Promise<SavedSshHost> {
    await waitForFinish();
    await input.beforeSave?.();
    return SAVED_HOST;
  }

  return {
    probeHost,
    isWaiting: () => finishProbe !== null,
    finish: () => finishProbe?.(),
  };
}

/** Open an Android form (with key import) whose probe succeeds unless told otherwise. */
function openAndroidForm(options: { failure?: unknown } = {}) {
  const keyImport = createTestSshKeyImport();
  const probe = createTestProbe(options);
  const model = openRemoteSshForm({ keyImport, probeHost: probe.probeHost });
  return { model, keyImport, probe };
}

/** Yield microtasks until `condition` holds; fails instead of hanging if it never does. */
async function waitFor(condition: () => boolean) {
  for (let tick = 0; tick < 100; tick += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached");
}

/** Bring an Android form to the approval step for `ssh://deploy@example.com`. */
async function inspectExampleHost(model: RemoteSshFormModel) {
  model.setTarget("ssh://deploy@example.com");
  await model.importKey();
  await model.submit();
}

describe("openRemoteSshForm", () => {
  describe("validation", () => {
    it("requires a target", async () => {
      const { model } = openAndroidForm();

      await expect(model.submit()).resolves.toBeNull();

      expect(model.getState().error).toEqual({ kind: "targetRequired" });
    });

    it("rejects a target that is not an ssh:// URI", async () => {
      const { model } = openAndroidForm();
      model.setTarget("deploy@example.com");

      await model.submit();

      expect(model.getState().error).toEqual({ kind: "invalidTarget" });
    });

    it("requires an imported key on Android", async () => {
      const { model, keyImport } = openAndroidForm();
      model.setTarget("ssh://deploy@example.com");

      await model.submit();

      expect(model.getState().error).toEqual({ kind: "keyRequired" });
      expect(keyImport.calls.inspect).toHaveLength(0);
    });
  });

  describe("Android key import", () => {
    it("shows the imported key name and returns to idle", async () => {
      const { model } = openAndroidForm();

      await model.importKey();

      expect(model.getState()).toMatchObject({ phase: "idle", keyName: "id_ed25519" });
    });

    it("reports a picker failure with its message", async () => {
      const keyImport = createTestSshKeyImport();
      keyImport.importPrivateKey = async () => {
        throw new Error("Choose a private key smaller than 64 KiB.");
      };
      const model = openRemoteSshForm({ keyImport, probeHost: createTestProbe().probeHost });

      await model.importKey();

      expect(model.getState().error).toEqual({
        kind: "importFailed",
        detail: "Choose a private key smaller than 64 KiB.",
      });
    });

    it("inspects the server before saving and shows its fingerprint", async () => {
      const { model, keyImport, probe } = openAndroidForm();

      await inspectExampleHost(model);

      expect(keyImport.calls.inspect).toEqual([{ host: "deploy@example.com", daemonPort: 6767 }]);
      expect(model.getState()).toMatchObject({ phase: "idle", fingerprint: "SHA256:test-server" });
      expect(probe.inputs).toHaveLength(0);
    });

    it("stages, commits and discards the approved key around the host probe", async () => {
      const { model, keyImport, probe } = openAndroidForm();
      await inspectExampleHost(model);
      model.setPassword("daemon-secret");

      await expect(model.submit()).resolves.toBe(SAVED_HOST);

      expect(keyImport.calls.stage).toEqual(["ssh:deploy%40example.com::"]);
      expect(keyImport.calls.commit).toEqual(["ssh:deploy%40example.com::"]);
      expect(keyImport.calls.discard).toEqual(["ssh:deploy%40example.com::"]);
      expect(probe.inputs[0]).toMatchObject({
        host: "deploy@example.com",
        password: "daemon-secret",
      });
    });

    it("requires a new approval when the target changes", async () => {
      const { model } = openAndroidForm();
      await inspectExampleHost(model);

      model.setTarget("ssh://deploy@other.example.com");

      expect(model.getState().fingerprint).toBeNull();
    });

    it("requires a new approval when the passphrase changes", async () => {
      const { model } = openAndroidForm();
      await inspectExampleHost(model);

      model.setPassphrase("new passphrase");

      expect(model.getState().fingerprint).toBeNull();
    });

    it("shows a native bridge failure as a connection error", async () => {
      const { model, keyImport } = openAndroidForm();
      keyImport.failNextInspect(new SshBridgeError("ERR_SSH_UNREACHABLE"));

      await inspectExampleHost(model);

      expect(model.getState().error).toEqual({
        kind: "connectionFailed",
        detail: "Unable to reach the SSH server. Check the hostname and port.",
      });
    });
  });

  describe("desktop", () => {
    /** Open a desktop form (no key import) for `ssh://deploy@example.com`. */
    function openDesktopForm(options: { failure?: unknown } = {}) {
      const probe = createTestProbe(options);
      const model = openRemoteSshForm({ keyImport: null, probeHost: probe.probeHost });
      model.setTarget("ssh://deploy@example.com");
      return { model, probe };
    }

    it("probes and saves the host without inspection", async () => {
      const { model, probe } = openDesktopForm();

      await expect(model.submit()).resolves.toBe(SAVED_HOST);

      expect(probe.inputs[0]).toMatchObject({ host: "deploy@example.com", password: undefined });
    });

    it("shows a daemon probe failure as a connection error", async () => {
      const { model } = openDesktopForm({
        failure: new DaemonConnectionTestError("Daemon refused the connection.", {
          reason: null,
          lastError: null,
        }),
      });

      await model.submit();

      expect(model.getState().error).toEqual({
        kind: "connectionFailed",
        detail: "Daemon refused the connection.",
      });
    });

    it("shows other save failures generically", async () => {
      const { model } = openDesktopForm({ failure: new Error("disk full") });

      await model.submit();

      expect(model.getState().error).toEqual({ kind: "unableToSave" });
    });
  });

  describe("dismissal", () => {
    it("ignores a fingerprint that arrives after the form closes", async () => {
      const { model, keyImport } = openAndroidForm();
      const inspection = keyImport.holdNext("inspect");
      model.setTarget("ssh://deploy@example.com");
      await model.importKey();
      const submitted = model.submit();

      model.close();
      inspection.release("SHA256:stale");

      await expect(submitted).resolves.toBeNull();
      expect(model.getState().fingerprint).toBeNull();
    });

    it("cancels a probe that succeeds after the form closes, before committing", async () => {
      const keyImport: TestSshKeyImport = createTestSshKeyImport();
      const probe = createHeldProbe();
      const model = openRemoteSshForm({ keyImport, probeHost: probe.probeHost });
      await inspectExampleHost(model);
      const submitted = model.submit();
      await waitFor(probe.isWaiting);

      model.close();
      probe.finish();

      await expect(submitted).resolves.toBeNull();
      expect(keyImport.calls.commit).toHaveLength(0);
      expect(keyImport.calls.discard).toHaveLength(1);
    });
  });
});
