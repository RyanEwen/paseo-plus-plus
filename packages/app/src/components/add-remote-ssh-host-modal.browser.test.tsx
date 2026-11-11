import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { SshBridgeError } from "@/hosts/ssh/ssh-native-bridge";
import { createTestSshKeyImport, type TestSshKeyImport } from "@/hosts/ssh/test-ssh-key-import";
import { RemoteSshHostForm } from "./remote-ssh-host-form";

void testI18n;
// The browser cannot execute Android Keystore or the native picker. The form receives them
// through its key import port; the real form, editing primitives, and approval run in Chromium.
const save = vi.fn();
let keyImport: TestSshKeyImport;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("React", React);
  keyImport = createTestSshKeyImport();
  save.mockReset().mockImplementation(async (input) => {
    await input.beforeSave();
    return { profile: { serverId: "srv_ssh" }, serverId: "srv_ssh", hostname: "server" };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Edit through the real uncontrolled input rather than assigning component state. */
function typeTarget(text: string) {
  const input = within(document.body).getByLabelText("SSH host") as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!valueSetter) throw new Error("HTML input value setter is unavailable");
  act(() => {
    valueSetter.call(input, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  });
}
async function click(label: string) {
  await act(async () => within(document.body).getByRole("button", { name: label }).click());
}
function renderForm(visible: boolean, onSaved = vi.fn()) {
  const onClose = vi.fn(() => renderForm(false, onSaved));
  act(() =>
    root.render(
      <RemoteSshHostForm
        hosts={[]}
        probeAndUpsertRemoteSshConnection={save}
        keyImport={keyImport}
        visible={visible}
        onClose={onClose}
        onSaved={onSaved}
      />,
    ),
  );
}
function mount() {
  const onSaved = vi.fn();
  renderForm(true, onSaved);
  return onSaved;
}

describe("Android SSH key import form", () => {
  it("requires fingerprint approval before connecting and clears credentials after success", async () => {
    const onSaved = mount();
    const password = within(document.body).getByLabelText("Daemon password");
    expect(password).toHaveProperty("type", "password");
    await click("Show password");
    expect(password).toHaveProperty("type", "text");
    await click("Hide password");
    expect(password).toHaveProperty("type", "password");
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    expect(within(document.body).getByTestId("ssh-server-fingerprint").textContent).toBe(
      "SHA256:test-server",
    );
    expect(save).toHaveBeenCalledTimes(0);
    await click("Trust and connect");
    expect(save).toHaveBeenCalledTimes(1);
    expect(keyImport.calls.commit).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledWith({
      profile: { serverId: "srv_ssh" },
      serverId: "srv_ssh",
      hostname: "server",
      isNewHost: true,
    });
    expect(within(document.body).queryByLabelText("SSH host")).toBeNull();
    mount();
    expect(
      within(document.body).getByRole("button", { name: "Import private key" }).textContent,
    ).toBe("Import private key");
    expect((within(document.body).getByLabelText("SSH host") as HTMLInputElement).value).toBe("");
  });
  it("reports the saved host before closing the form", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    act(() =>
      root.render(
        <RemoteSshHostForm
          hosts={[]}
          probeAndUpsertRemoteSshConnection={save}
          keyImport={keyImport}
          visible
          onClose={onClose}
          onSaved={onSaved}
        />,
      ),
    );
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    await click("Trust and connect");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSaved.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  });
  it("shows import errors in the form and lets the user retry without losing the target", async () => {
    keyImport.failNextInspect(new SshBridgeError("ERR_SSH_KEY_UNREADABLE"));
    mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    expect(
      within(document.body).queryByText(
        "Unable to connect over SSH. Unable to read the private key. Check its format and passphrase.",
      ),
    ).not.toBeNull();
    expect((within(document.body).getByLabelText("SSH host") as HTMLInputElement).value).toBe(
      "ssh://deploy@example.com",
    );
    await click("Connect");
    expect(within(document.body).getByTestId("ssh-server-fingerprint").textContent).toBe(
      "SHA256:test-server",
    );
  });
  it("requires fingerprint approval again when the destination changes", async () => {
    mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    typeTarget("ssh://deploy@other.example.com");
    expect(within(document.body).queryByTestId("ssh-server-fingerprint")).toBeNull();
    await click("Connect");
    expect(keyImport.calls.inspect).toHaveLength(2);
    expect(save).toHaveBeenCalledTimes(0);
  });
  it("accepts dismissal while fingerprint inspection is pending and reopens with fresh inputs", async () => {
    const inspection = keyImport.holdNext("inspect");
    mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    act(() => within(document.body).getByRole("button", { name: "Connect" }).click());
    await click("Cancel");
    expect(within(document.body).queryByLabelText("SSH host")).toBeNull();
    mount();
    await act(async () => inspection.release("SHA256:stale"));
    expect(within(document.body).queryByTestId("ssh-server-fingerprint")).toBeNull();
    expect((within(document.body).getByLabelText("SSH host") as HTMLInputElement).value).toBe("");
    expect(save).not.toHaveBeenCalled();
  });
  it("ignores a picker result after the parent hides the form", async () => {
    const pick = keyImport.holdNext("pick");
    mount();
    act(() => within(document.body).getByRole("button", { name: "Import private key" }).click());
    renderForm(false);
    mount();
    await act(async () => pick.release({ name: "stale-key", text: "private-key" }));
    expect(
      within(document.body).getByRole("button", { name: "Import private key" }).textContent,
    ).toBe("Import private key");
  });
  it("discards credentials staged after dismissal without starting a host probe", async () => {
    const staging = keyImport.holdNext("stage");
    mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await click("Cancel");
    await act(async () => staging.release(undefined));
    expect(save).not.toHaveBeenCalled();
    expect(keyImport.calls.commit).toHaveLength(0);
    expect(keyImport.calls.discard).toHaveLength(1);
  });
  it("rejects a late successful probe before committing credentials or publishing a host", async () => {
    let finishProbe: () => void = () => {};
    save.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        finishProbe = resolve;
      });
      await input.beforeSave();
      return { profile: { serverId: "srv_ssh" }, serverId: "srv_ssh", hostname: "server" };
    });
    const onSaved = mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await act(async () => {});
    await click("Cancel");
    await act(async () => finishProbe());
    expect(keyImport.calls.commit).toHaveLength(0);
    expect(keyImport.calls.discard).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("serializes imports when a cancelled form is reopened for the same destination", async () => {
    let finishOldProbe: () => void = () => {};
    save.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        finishOldProbe = resolve;
      });
      await input.beforeSave();
      return { profile: { serverId: "srv_ssh" }, serverId: "srv_ssh", hostname: "server" };
    });
    const oldSaved = mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await act(async () => {});
    await click("Cancel");

    const newSaved = mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await act(async () => {});
    expect(keyImport.calls.stage).toHaveLength(1);
    await act(async () => finishOldProbe());
    expect(keyImport.calls.stage).toHaveLength(2);
    expect(keyImport.calls.discard).toHaveLength(2);
    expect(keyImport.calls.commit).toHaveLength(1);
    expect(oldSaved).not.toHaveBeenCalled();
    expect(newSaved).toHaveBeenCalledTimes(1);
  });
  it("finishes publishing the host if dismissed after durable commit has begun", async () => {
    const commit = keyImport.holdNext("commit");
    const published = vi.fn();
    save.mockImplementationOnce(async (input) => {
      await input.beforeSave();
      published();
      return { profile: { serverId: "srv_ssh" }, serverId: "srv_ssh", hostname: "server" };
    });
    const onSaved = mount();
    typeTarget("ssh://deploy@example.com");
    await click("Import private key");
    await click("Connect");
    act(() => within(document.body).getByRole("button", { name: "Trust and connect" }).click());
    await act(async () => {});
    expect(keyImport.calls.commit).toHaveLength(1);
    await click("Cancel");
    await act(async () => commit.release(undefined));
    expect(published).toHaveBeenCalledTimes(1);
    expect(keyImport.calls.discard).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
