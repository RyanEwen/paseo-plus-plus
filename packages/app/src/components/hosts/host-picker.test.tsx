/** @vitest-environment jsdom */
import React, { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostUpdateAction, HostUpdateSheet } from "./host-update-action";
import { HostPickerOption } from "./host-picker";
import { defaultHostAppearance } from "@/hosts/appearance";
import { i18n } from "@/i18n/i18next";
import type { HostProfile } from "@/types/host-connection";
void i18n;

const runtime = vi.hoisted(() => ({
  connected: true,
  version: "0.11.1-preview.12",
  pid: 1,
  check: vi.fn(),
  update: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    checkDaemonUpdateAvailability: runtime.check,
    updateDaemon: runtime.update,
    getDaemonStatus: async () => ({ pid: runtime.pid }),
    getLastServerInfoMessage: () => ({ serverId: "host-a", version: runtime.version }),
    on: () => () => {},
  }),
  useHostRuntimeIsConnected: () => runtime.connected,
  useHostRuntimeSnapshot: () => ({ activeConnection: null }),
  useHostRuntimeConnectionStatus: () => (runtime.connected ? "online" : "offline"),
  getHostRuntimeStore: () => ({ getSnapshot: () => runtime.connected }),
  isHostRuntimeConnected: (connected: boolean) => connected,
}));
vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: runtime.confirm }));
// The real picker row imports the popover module, but these cases never render a popover.
// Keep native positioning outside this DOM unit boundary and fail if a case starts using it.
vi.mock("@floating-ui/react-native", () => {
  function unexpectedPopoverPositioning(): never {
    throw new Error("Host picker row tests must not invoke native popover positioning");
  }
  return {
    flip: unexpectedPopoverPositioning,
    offset: unexpectedPopoverPositioning,
    shift: unexpectedPopoverPositioning,
    size: unexpectedPopoverPositioning,
    useFloating: unexpectedPopoverPositioning,
  };
});
// The native sheet boundary is substituted; the shared update hook, lifecycle and rendered feedback are real.
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? <div>{children}</div> : null,
}));
import {
  ADD_HOST_OPTION_ID,
  ALL_HOSTS_OPTION_ID,
  getHostPickerLabel,
} from "./host-picker-constants";

const hosts = [{ serverId: "host-a", label: "Host A" }];

it.each([
  ["host-a", undefined, "Host A"],
  ["missing", undefined, "Host"],
  [ALL_HOSTS_OPTION_ID, { includeAllHost: true }, "All hosts"],
  ["missing", { includeAllHost: true }, "All hosts"],
  [ALL_HOSTS_OPTION_ID, undefined, "Host"],
  [ADD_HOST_OPTION_ID, { includeAddHost: true }, "Add host"],
])("resolves %s", (value, config, expected) => {
  expect(getHostPickerLabel(hosts, value, config)).toBe(expected);
});

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;
const updateHost: HostProfile = {
  serverId: "host-a",
  label: "Host A",
  connections: [],
  appearance: defaultHostAppearance(),
  lifecycle: {},
  preferredConnectionId: null,
  createdAt: "2026-10-14T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
};
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  notifyManager.setScheduler(queueMicrotask);
  runtime.connected = true;
  runtime.version = "0.11.1-preview.12";
  runtime.pid = 1;
  runtime.check.mockReset().mockResolvedValue({ version: "0.11.1-preview.13", reason: null });
  runtime.confirm.mockReset().mockResolvedValue(true);
  runtime.update.mockReset().mockImplementation(async () => {
    runtime.pid = 2;
    runtime.version = "0.11.1-preview.13";
    return { success: true, error: null, newVersion: runtime.version };
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  container.remove();
  vi.unstubAllGlobals();
});
async function renderAction(
  options: {
    supportsAvailability?: boolean;
    legacyManualUpdate?: boolean;
    onUpdate?: (host: HostProfile) => void;
    onRow?: () => void;
  } = {},
) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <div onClick={options.onRow}>
          <HostUpdateAction
            host={updateHost}
            supportsAvailability={options.supportsAvailability ?? true}
            legacyManualUpdate={options.legacyManualUpdate ?? false}
            daemonVersion={runtime.version}
            enabled
            busy={false}
            onUpdate={options.onUpdate ?? vi.fn()}
          />
        </div>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {});
}

describe("footer host update actions", () => {
  it("offers confirmed updates and pressing update does not select the host row", async () => {
    const onUpdate = vi.fn();
    const onRow = vi.fn();
    await renderAction({ onUpdate, onRow });
    await act(async () => within(container).getByRole("button", { name: "Update Host A" }).click());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(updateHost);
    expect(onRow).not.toHaveBeenCalled();
  });
  it("offers the shared manual action for a connected host missing availability capability", async () => {
    const onUpdate = vi.fn();
    await renderAction({
      supportsAvailability: false,
      legacyManualUpdate: true,
      onUpdate,
    });
    expect(runtime.check).not.toHaveBeenCalled();
    await act(async () => within(container).getByRole("button", { name: "Update Host A" }).click());
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(updateHost);
  });
  it("keeps an unhydrated host hidden without checking availability", async () => {
    await renderAction({ supportsAvailability: false });
    expect(runtime.check).not.toHaveBeenCalled();
    expect(within(container).queryByRole("button", { name: "Update Host A" })).toBeNull();
  });
  it("keeps the legacy manual action hidden while disconnected", async () => {
    runtime.connected = false;
    await renderAction({ supportsAvailability: false, legacyManualUpdate: true });
    expect(runtime.check).not.toHaveBeenCalled();
    expect(within(container).queryByRole("button", { name: "Update Host A" })).toBeNull();
  });
  it.each(["ineligible", "failed", "offline"])(
    "does not offer an update when %s",
    async (scenario) => {
      if (scenario === "ineligible")
        runtime.check.mockResolvedValue({ version: null, reason: "Source installation" });
      if (scenario === "failed")
        runtime.check.mockRejectedValue(new Error("Release service unavailable"));
      if (scenario === "offline") runtime.connected = false;
      await renderAction();
      expect(within(container).queryByRole("button", { name: "Update Host A" })).toBeNull();
    },
  );
  it("preserves confirmation cancellation without installing", async () => {
    runtime.confirm.mockResolvedValue(false);
    const closed = vi.fn();
    await act(async () =>
      root.render(<HostUpdateSheet host={updateHost} onFinished={vi.fn()} onClose={closed} />),
    );
    expect(runtime.update).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
  });
  it("shows success only after the replacement worker reports the installed version", async () => {
    await act(async () =>
      root.render(<HostUpdateSheet host={updateHost} onFinished={vi.fn()} onClose={vi.fn()} />),
    );
    expect(within(container).getByText(/0.11.1-preview.13/).textContent).toContain(
      "0.11.1-preview.13",
    );
    expect(runtime.update).toHaveBeenCalledOnce();
  });
  it("can dismiss progress while replacement-worker verification stays owned", async () => {
    let finishInstall:
      | ((result: { success: boolean; error: null; newVersion: string }) => void)
      | undefined;
    runtime.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInstall = resolve;
        }),
    );
    const finished = vi.fn();
    const closed = vi.fn();
    await act(async () =>
      root.render(<HostUpdateSheet host={updateHost} onFinished={finished} onClose={closed} />),
    );
    expect(runtime.update).toHaveBeenCalledOnce();
    await act(async () => within(container).getByRole("button", { name: "Close" }).click());
    expect(within(container).queryByRole("button", { name: "Close" })).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    await act(async () => {
      runtime.pid = 2;
      runtime.version = "0.11.1-preview.13";
      if (!finishInstall) throw new Error("Expected pending installation");
      finishInstall({ success: true, error: null, newVersion: runtime.version });
    });
    expect(finished).toHaveBeenCalledOnce();
  });
  it("retains an actionable failure when installation fails", async () => {
    runtime.update.mockResolvedValue({
      success: false,
      error: "Installation denied",
      newVersion: null,
    });
    await act(async () =>
      root.render(<HostUpdateSheet host={updateHost} onFinished={vi.fn()} onClose={vi.fn()} />),
    );
    expect(within(container).getByText(/Installation denied/).textContent).toContain(
      "Installation denied",
    );
    expect(
      within(container).getByRole("button", { name: "Close" }).getAttribute("aria-disabled"),
    ).not.toBe("true");
  });
});

interface HostRowActionsProps {
  onRow: () => void;
  onSettings: (serverId: string) => void;
  onUpdate: (host: HostProfile) => void;
}

/** Exercise the existing fork update action through the real picker row's stable action slot. */
function HostRowActions({ onRow, onSettings, onUpdate }: HostRowActionsProps) {
  const daemonVersion = runtime.version;
  const renderHostAction = useCallback(
    () => (
      <HostUpdateAction
        host={updateHost}
        supportsAvailability
        legacyManualUpdate={false}
        daemonVersion={daemonVersion}
        enabled
        busy={false}
        onUpdate={onUpdate}
      />
    ),
    [daemonVersion, onUpdate],
  );
  return (
    <HostPickerOption
      serverId={updateHost.serverId}
      label={updateHost.label}
      showActiveConnection={false}
      active={false}
      onPress={onRow}
      onOpenHostSettings={onSettings}
      renderHostAction={renderHostAction}
    />
  );
}

describe("host picker independent row actions", () => {
  it("keeps host selection, settings and update as independent focus targets without button nesting", async () => {
    const onRow = vi.fn();
    const onSettings = vi.fn();
    const onUpdate = vi.fn();
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <HostRowActions onRow={onRow} onSettings={onSettings} onUpdate={onUpdate} />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {});
    const primary = within(container).getByRole("button", { name: "Host A" });
    const settings = within(container).getByRole("button", { name: "Open Host A settings" });
    const update = within(container).getByRole("button", { name: "Update Host A" });

    expect(primary.contains(settings)).toBe(false);
    expect(primary.contains(update)).toBe(false);
    for (const control of [primary, settings, update]) {
      expect(control.parentElement?.closest("button, [role='button']") ?? null).toBeNull();
      expect(control.tabIndex).toBe(0);
      await act(async () => control.focus());
      expect(document.activeElement).toBe(control);
    }

    const onAncestorClick = vi.fn();
    document.body.addEventListener("click", onAncestorClick);
    try {
      await act(async () => update.click());
      await act(async () => settings.click());
      expect(onUpdate).toHaveBeenCalledExactlyOnceWith(updateHost);
      expect(onSettings).toHaveBeenCalledExactlyOnceWith("host-a");
      expect(onRow).not.toHaveBeenCalled();
      expect(onAncestorClick).not.toHaveBeenCalled();
      await act(async () => primary.click());
      expect(onRow).toHaveBeenCalledOnce();
      expect(onAncestorClick).not.toHaveBeenCalled();
    } finally {
      document.body.removeEventListener("click", onAncestorClick);
    }
  });

  it("keeps the plain host option selectable without an action wrapper", async () => {
    const onRow = vi.fn();
    await act(async () =>
      root.render(
        <HostPickerOption
          serverId={updateHost.serverId}
          label={updateHost.label}
          showActiveConnection={false}
          selected
          active={false}
          onPress={onRow}
        />,
      ),
    );
    const primary = within(container).getByRole("button", { name: "Host A" });
    expect(within(container).getAllByRole("button")).toHaveLength(1);
    expect(container.firstElementChild).toBe(primary);
    expect(primary.querySelector("button, [role='button']")).toBeNull();
    await act(async () => primary.click());
    expect(onRow).toHaveBeenCalledOnce();
  });
});
