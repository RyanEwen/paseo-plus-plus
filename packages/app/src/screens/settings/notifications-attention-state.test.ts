import { describe, expect, test } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { resolveAttentionControlState } from "./notifications-attention-state";

const disabledPreference = {
  notifications: { agentAwareAttention: false },
} as MutableDaemonConfig;
const ready = {
  host: "Studio",
  connected: true,
  supported: true,
  writable: true,
  config: disabledPreference,
  isLoading: false,
  loadFailed: false,
  isPending: false,
};

describe("resolveAttentionControlState", () => {
  test("shows the host's stored preference when it can be changed", () => {
    expect(resolveAttentionControlState(ready)).toEqual({
      visible: true,
      value: false,
      disabled: false,
      hint: { key: "settings.notifications.agentAwareHint", host: "Studio" },
    });
  });

  test("hides the switch while the preference loads instead of flashing the default", () => {
    expect(resolveAttentionControlState({ ...ready, config: null, isLoading: true })).toMatchObject(
      { visible: false, disabled: true },
    );
  });

  test.each([
    {
      name: "a disconnected host",
      input: { connected: false, config: null },
      hint: "workspace.terminal.hostDisconnected",
    },
    {
      name: "an older host",
      input: { supported: false, config: null },
      hint: "settings.notifications.updateHost",
    },
    {
      name: "a session without management permission",
      input: { writable: false },
      hint: "settings.notifications.readOnly",
    },
    { name: "a pending save", input: { isPending: true }, hint: "settings.notifications.saving" },
  ])("disables the switch and explains $name", ({ input, hint }) => {
    expect(resolveAttentionControlState({ ...ready, ...input })).toMatchObject({
      visible: true,
      disabled: true,
      hint: { key: hint },
    });
  });

  test("keeps the switch visible and disabled after a load failure", () => {
    expect(
      resolveAttentionControlState({ ...ready, config: null, loadFailed: true }),
    ).toMatchObject({ visible: true, disabled: true, value: true });
  });
});
