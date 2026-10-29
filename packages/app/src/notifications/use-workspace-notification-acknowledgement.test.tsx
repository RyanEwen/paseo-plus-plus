// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceNotificationReceipts } from "@getpaseo/protocol/notification-receipts";
import { useWorkspaceNotificationAcknowledgement } from "./use-workspace-notification-acknowledgement";

// Control external visibility and notification-runtime ports, not React hooks or
// the production admission condition. Publication may lag behind UI motion.
const ports = vi.hoisted(() => {
  const motion = { atRest: true };
  const layout = { compact: true };
  const listeners = new Set<() => void>();
  const release = vi.fn();
  return {
    motion,
    layout,
    listeners,
    release,
    open: vi.fn(() => release),
    isAtRest: () => motion.atRest,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("@/hooks/use-app-visible", () => ({ useAppActivelyVisible: () => true }));
vi.mock("@/components/retained-panel", () => ({ useRetainedPanelActive: () => true }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => ports.layout.compact }));
vi.mock("@/mobile-panels/provider", () => ({
  useIsMobilePanelActive: () => true,
  useMobilePanelVisibilityCheck: () => ({ isAtRest: ports.isAtRest, subscribe: ports.subscribe }),
}));
vi.mock("@/stores/panel-store", () => ({
  usePanelStore: (select: (state: { mobilePanel: { target: "agent" } }) => unknown) =>
    select({ mobilePanel: { target: "agent" } }),
}));
vi.mock("./workspace-receipts-runtime", () => ({
  workspaceNotificationRuntime: { open: ports.open },
}));

type Input = Parameters<typeof useWorkspaceNotificationAcknowledgement>[0];

function receipt(latestSequence: number): WorkspaceNotificationReceipts {
  return { latestSequence, acknowledgedThrough: 0, dismissedSequences: [] };
}

/** Deliver the provider's existing RN notification, which reads current motion
 * when invoked rather than retaining the earlier boolean edge. */
function publishMotion() {
  act(() => {
    for (const listener of ports.listeners) listener();
  });
}

describe("workspace notification foreground admission", () => {
  beforeEach(() => {
    ports.motion.atRest = true;
    ports.layout.compact = true;
    ports.open.mockClear();
    ports.release.mockClear();
    ports.listeners.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it.each(["focus", "first receipt"] as const)(
    "waits for actual rest when %s activates while motion publication is held, then recovers",
    (activation) => {
      const captured = receipt(3);
      const initial: Input = {
        serverId: "host",
        workspaceId: "workspace",
        focused: activation !== "focus",
        workspace: activation === "first receipt" ? null : { notificationReceipts: captured },
      };
      const { rerender, unmount } = renderHook(
        (input: Input) => useWorkspaceNotificationAcknowledgement(input),
        { initialProps: initial },
      );
      expect(ports.listeners.size).toBe(1);
      expect(ports.open).not.toHaveBeenCalled();

      // UI admitted a drag; both requested and active panel still name agent.
      // Hold scheduleOnRN delivery so the hook's prior settled value is true.
      ports.motion.atRest = false;
      rerender({ ...initial, focused: true, workspace: { notificationReceipts: captured } });
      expect(ports.open).not.toHaveBeenCalled();

      // End the drag before RN delivers either boundary. Both callbacks now
      // read true. A suppression-only fix must not strand this eligible lease.
      ports.motion.atRest = true;
      publishMotion();
      publishMotion();
      expect(ports.open).toHaveBeenCalledTimes(1);
      expect(ports.open).toHaveBeenCalledWith("host", "workspace", captured);
      unmount();
      expect(ports.release).toHaveBeenCalledTimes(1);
      expect(ports.listeners.size).toBe(0);
    },
  );

  it("retains a valid pre-drag boundary without widening it while publication is held", () => {
    const captured = receipt(3);
    const initial: Input = {
      serverId: "host",
      workspaceId: "workspace",
      focused: true,
      workspace: { notificationReceipts: captured },
    };
    const { rerender, unmount } = renderHook(
      (input: Input) => useWorkspaceNotificationAcknowledgement(input),
      { initialProps: initial },
    );
    expect(ports.open).toHaveBeenCalledExactlyOnceWith("host", "workspace", captured);

    ports.motion.atRest = false;
    rerender({ ...initial, workspace: { notificationReceipts: receipt(4) } });
    expect(ports.open).toHaveBeenCalledExactlyOnceWith("host", "workspace", captured);
    expect(ports.release).not.toHaveBeenCalled();

    ports.motion.atRest = true;
    publishMotion();
    publishMotion();
    expect(ports.open).toHaveBeenCalledExactlyOnceWith("host", "workspace", captured);
    unmount();
    expect(ports.release).toHaveBeenCalledTimes(1);
    expect(ports.listeners.size).toBe(0);
  });

  it("keeps the original read boundary across a visible desktop-to-compact resize", () => {
    ports.layout.compact = false;
    const captured = receipt(3);
    const initial: Input = {
      serverId: "host",
      workspaceId: "workspace",
      focused: true,
      workspace: { notificationReceipts: captured },
    };
    const { rerender, unmount } = renderHook(
      (input: Input) => useWorkspaceNotificationAcknowledgement(input),
      { initialProps: initial },
    );
    expect(ports.open).toHaveBeenCalledExactlyOnceWith("host", "workspace", captured);

    const updated: Input = { ...initial, workspace: { notificationReceipts: receipt(4) } };
    rerender(updated);
    expect(ports.open).toHaveBeenCalledExactlyOnceWith("host", "workspace", captured);
    expect(ports.release).not.toHaveBeenCalled();

    // The same workspace stays selected, foreground and at rest during resize.
    // A layout breakpoint is not a new read activation.
    ports.layout.compact = true;
    rerender(updated);
    expect(ports.open).toHaveBeenCalledExactlyOnceWith("host", "workspace", captured);
    expect(ports.release).not.toHaveBeenCalled();

    unmount();
    expect(ports.release).toHaveBeenCalledTimes(1);
    expect(ports.listeners.size).toBe(0);
  });
});
