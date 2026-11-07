import { describe, expect, it } from "vitest";
import { createSshNativeBridge, SshBridgeError, type SshNativeModule } from "./ssh-native-bridge";

/**
 * Build the rejection Expo Modules Core produces for a throwing AsyncFunction: the message is
 * prefixed by FunctionCallException and only `code` survives intact.
 */
function expoRejection(functionName: string, code: string, cause: string): Error {
  const error = new Error(
    `Call to function 'PaseoSsh.${functionName}' has been rejected.\n→ Caused by: ${cause}`,
  );
  return Object.assign(error, { code });
}

/** A native module whose every call rejects with `failure`. */
function rejectingNative(failure: Error): SshNativeModule {
  async function reject(): Promise<never> {
    throw failure;
  }
  return {
    inspect: reject,
    stage: reject,
    commit: reject,
    discard: reject,
    remove: reject,
    open: reject,
    send: reject,
    close: reject,
    addListener: () => ({ remove: () => {} }),
  };
}

describe("createSshNativeBridge", () => {
  it("replaces Expo's call envelope with the copy for a known SSH error code", async () => {
    const bridge = createSshNativeBridge(
      rejectingNative(
        expoRejection(
          "inspect",
          "ERR_SSH_KEY_UNREADABLE",
          "Unable to read the private key. Check its format and passphrase.",
        ),
      ),
    );

    const failure = await bridge
      .inspect({ host: "deploy@example.com" }, "key", "")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SshBridgeError);
    expect(failure).toMatchObject({
      code: "ERR_SSH_KEY_UNREADABLE",
      message: "Unable to read the private key. Check its format and passphrase.",
    });
  });

  it("hides Java exception text for failures without a known SSH code", async () => {
    const bridge = createSshNativeBridge(
      rejectingNative(
        expoRejection(
          "commit",
          "ERR_UNEXPECTED",
          "java.lang.IllegalStateException: SSH module is closed.",
        ),
      ),
    );

    const failure = await bridge.commit("ssh:deploy@example.com").catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: null,
      message: "The SSH bridge failed unexpectedly. Try again.",
    });
  });

  it("translates tunnel setup failures that reach the daemon probe", async () => {
    const bridge = createSshNativeBridge(
      rejectingNative(
        expoRejection(
          "open",
          "ERR_SSH_KEY_MISSING",
          "Import a private key for this SSH host on this device.",
        ),
      ),
    );

    await expect(
      bridge.open("session", "ssh:deploy@example.com", { host: "deploy@example.com" }),
    ).rejects.toThrow(/^Import a private key for this SSH host on this device\.$/);
  });

  it("returns native results unchanged", async () => {
    const native = rejectingNative(new Error("unused"));
    native.inspect = async () => "SHA256:server";
    const bridge = createSshNativeBridge(native);

    await expect(bridge.inspect({ host: "deploy@example.com" }, "key", "")).resolves.toBe(
      "SHA256:server",
    );
  });
});
