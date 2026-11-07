// @vitest-environment jsdom
import React, { useEffect, useRef } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWebOverlayPresentationLifetime } from "./overlay-presentation-lifetime";
import { installWebOverlayPresentationGuard } from "./overlay-presentation";
import { dispatchTopWebOverlayKeyDown, useWebOverlayRegistration } from "./overlay-root";

describe("useWebOverlayRegistration", () => {
  let opener: HTMLButtonElement;
  let input: HTMLInputElement;
  let scope: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    opener = document.createElement("button");
    input = document.createElement("input");
    scope = document.createElement("div");
    scope.tabIndex = -1;
    scope.inert = false;
    scope.append(input);
    document.body.append(opener, scope);
    opener.focus();
    expect(document.activeElement).toBe(opener);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("does not restore opener focus when an active overlay scope detaches", () => {
    const { result, unmount } = renderHook(() =>
      useWebOverlayRegistration({ active: true, layer: 20, onKeyDown: () => false }),
    );

    act(() => result.current(scope));
    const openerFocus = vi.spyOn(opener, "focus");
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => result.current(null));

    expect(openerFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    unmount();
  });

  it("restores opener focus when an overlay closes", () => {
    const { result, rerender, unmount } = renderHook(
      ({ active }: { active: boolean }) =>
        useWebOverlayRegistration({ active, layer: 20, onKeyDown: () => false }),
      { initialProps: { active: true } },
    );

    act(() => result.current(scope));
    const openerFocus = vi.spyOn(opener, "focus");
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => rerender({ active: false }));

    expect(openerFocus).toHaveBeenCalled();
    unmount();
  });

  it("restores opener focus when an active overlay unmounts after its scope detaches", () => {
    const { result, unmount } = renderHook(() =>
      useWebOverlayRegistration({ active: true, layer: 20, onKeyDown: () => false }),
    );

    act(() => result.current(scope));
    const openerFocus = vi.spyOn(opener, "focus");
    input.focus();
    expect(document.activeElement).toBe(input);

    act(() => result.current(null));
    expect(openerFocus).not.toHaveBeenCalled();

    unmount();

    expect(openerFocus).toHaveBeenCalled();
  });

  it("leaves IME composition keys with the focused editor", () => {
    const event = new KeyboardEvent("keydown", { key: "Process", bubbles: true });
    expect(dispatchTopWebOverlayKeyDown(event)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
  it("holds menu paint, interaction and focus until native admission while preserving measurement", async () => {
    let admit!: (ready: boolean) => void;
    const release = vi.fn();
    const guard = vi.fn(() => ({
      ready: new Promise<boolean>((resolve) => {
        admit = resolve;
      }),
      release,
    }));
    const uninstall = installWebOverlayPresentationGuard(guard);
    const onPresentationReady = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ layer }: { layer: number }) =>
        useWebOverlayRegistration({
          active: true,
          layer,
          onKeyDown: () => false,
          nativeBrowserOverlap: true,
          onPresentationReady,
        }),
      { initialProps: { layer: 20 } },
    );
    try {
      act(() => result.current(scope));
      expect(scope.inert).toBe(true);
      expect(scope.style.visibility).toBe("hidden");
      expect(scope.style.display).toBe("");
      expect(document.activeElement).toBe(opener);
      // Flyout/layout changes retain the actual scope registration and token.
      act(() => rerender({ layer: 30 }));
      expect(guard).toHaveBeenCalledTimes(1);
      await act(async () => {
        admit(true);
      });
      expect(scope.inert).toBe(false);
      expect(scope.style.visibility).toBe("");
      expect(onPresentationReady).toHaveBeenCalledOnce();
      unmount();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      unmount();
      uninstall();
    }
  });

  it("cancels pending admission on scope detach without exposing a late completion", async () => {
    let admit!: (ready: boolean) => void;
    const release = vi.fn();
    const uninstall = installWebOverlayPresentationGuard(() => ({
      ready: new Promise<boolean>((resolve) => {
        admit = resolve;
      }),
      release,
    }));
    const onPresentationReady = vi.fn();
    const { result, unmount } = renderHook(() =>
      useWebOverlayRegistration({
        active: true,
        layer: 20,
        onKeyDown: () => false,
        nativeBrowserOverlap: true,
        onPresentationReady,
      }),
    );
    try {
      act(() => result.current(scope));
      act(() => result.current(null));
      await act(async () => {
        admit(true);
      });
      expect(release).toHaveBeenCalledOnce();
      expect(onPresentationReady).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(opener);
    } finally {
      unmount();
      uninstall();
    }
  });

  it("admits an already open menu when the first native page installs protection", async () => {
    const onPresentationReady = vi.fn();
    const { result, unmount } = renderHook(() =>
      useWebOverlayRegistration({
        active: true,
        layer: 20,
        onKeyDown: () => false,
        nativeBrowserOverlap: true,
        onPresentationReady,
      }),
    );
    let uninstall = () => {};
    try {
      act(() => result.current(scope));
      let admit!: (ready: boolean) => void;
      const guard = vi.fn(() => ({
        ready: new Promise<boolean>((resolve) => {
          admit = resolve;
        }),
        release: vi.fn(),
      }));
      act(() => {
        uninstall = installWebOverlayPresentationGuard(guard);
      });
      expect(scope.inert).toBe(true);
      expect(guard).toHaveBeenCalledOnce();
      await act(async () => {
        admit(true);
      });
      expect(scope.inert).toBe(false);
    } finally {
      unmount();
      uninstall();
    }
  });
});

/** Exercise the Electron adapter in this existing DOM suite without a browser/runtime. */
/** Backdrop and keyboard panel deliberately have different scopes. */
function BlockingAdmissionProbe({
  active = true,
  identity,
  onAdmissionFailed,
  onFocusRequest,
}: {
  active?: boolean;
  identity?: unknown;
  onAdmissionFailed: () => void;
  onFocusRequest?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { ready, retainNode } = useWebOverlayPresentationLifetime({
    active,
    identity,
    nativeBrowserOverlap: true,
    onAdmissionFailed,
  });
  const setScope = useWebOverlayRegistration({
    active: active && ready,
    layer: 40,
    onKeyDown: () => false,
  });
  useEffect(() => {
    if (!active || !ready) return;
    const timer = setTimeout(() => {
      onFocusRequest?.();
      input.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [active, ready, onFocusRequest]);
  if (!active || !ready) return null;
  return (
    <div ref={retainNode} data-blocking-root>
      <button data-backdrop type="button">
        Dismiss
      </button>
      <div ref={setScope}>
        <input ref={input} autoFocus data-editor />
      </div>
    </div>
  );
}

describe("blocking web presentation lifetime", () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("withholds the whole backdrop and autofocus subtree until admission", async () => {
    let admit!: (ready: boolean) => void;
    const release = vi.fn();
    const focusRequest = vi.fn();
    const uninstall = installWebOverlayPresentationGuard(() => ({
      ready: new Promise<boolean>((resolve) => {
        admit = resolve;
      }),
      release,
    }));
    try {
      const view = render(
        <BlockingAdmissionProbe onAdmissionFailed={vi.fn()} onFocusRequest={focusRequest} />,
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.querySelector("[data-backdrop]")).toBeNull();
      expect(document.querySelector("[data-editor]")).toBeNull();
      expect(focusRequest).not.toHaveBeenCalled();
      await act(async () => {
        admit(true);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.querySelector("[data-backdrop]")).not.toBeNull();
      expect(document.activeElement).toBe(document.querySelector("[data-editor]"));
      expect(focusRequest).toHaveBeenCalledOnce();
      view.unmount();
      await act(async () => {});
      expect(release).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  });

  it("reports failed hide acknowledgement without mounting a misleading modal", async () => {
    const close = vi.fn();
    const release = vi.fn();
    const uninstall = installWebOverlayPresentationGuard(() => ({
      ready: Promise.resolve(false),
      release,
    }));
    try {
      const view = render(<BlockingAdmissionProbe onAdmissionFailed={close} />);
      await act(async () => {});
      expect(close).toHaveBeenCalledOnce();
      expect(document.querySelector("[data-blocking-root]")).toBeNull();
      view.unmount();
      await act(async () => {});
      expect(release).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  });

  it("fences late admission after request replacement and close", async () => {
    const replies: Array<(ready: boolean) => void> = [];
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const close = vi.fn();
    const uninstall = installWebOverlayPresentationGuard(() => {
      const release = vi.fn();
      releases.push(release);
      return { ready: new Promise<boolean>((resolve) => replies.push(resolve)), release };
    });
    try {
      const view = render(<BlockingAdmissionProbe identity="first" onAdmissionFailed={close} />);
      view.rerender(<BlockingAdmissionProbe identity="second" onAdmissionFailed={close} />);
      await act(async () => {
        replies[0]!(false);
      });
      expect(close).not.toHaveBeenCalled();
      expect(document.querySelector("[data-editor]")).toBeNull();
      view.unmount();
      await act(async () => {
        replies[1]!(true);
      });
      expect(document.querySelector("[data-editor]")).toBeNull();
      expect(releases).toHaveLength(2);
      for (const release of releases) expect(release).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  });

  it("retains ownership through actual closing DOM removal, independently of another overlay", async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const uninstall = installWebOverlayPresentationGuard(() => {
      const release = vi.fn();
      releases.push(release);
      return { ready: Promise.resolve(true), release };
    });
    const closingNode = document.createElement("div");
    document.body.append(closingNode);
    try {
      const first = renderHook(() =>
        useWebOverlayPresentationLifetime({
          active: true,
          nativeBrowserOverlap: true,
          onAdmissionFailed: vi.fn(),
        }),
      );
      const second = renderHook(() =>
        useWebOverlayPresentationLifetime({
          active: true,
          nativeBrowserOverlap: true,
          onAdmissionFailed: vi.fn(),
        }),
      );
      act(() => first.result.current.retainNode(closingNode));
      await act(async () => {});
      first.unmount();
      await act(async () => {});
      expect(releases[0]).not.toHaveBeenCalled();
      expect(releases[1]).not.toHaveBeenCalled();
      closingNode.remove();
      await act(async () => {});
      expect(releases[0]).toHaveBeenCalledOnce();
      expect(releases[1]).not.toHaveBeenCalled();
      second.unmount();
      await act(async () => {});
      expect(releases[1]).toHaveBeenCalledOnce();
    } finally {
      closingNode.remove();
      uninstall();
    }
  });

  it("acquires synchronously when the first native page installs its guard over an open modal", async () => {
    const release = vi.fn();
    const guard = vi.fn(() => ({ ready: Promise.resolve(true), release }));
    const view = render(<BlockingAdmissionProbe onAdmissionFailed={vi.fn()} />);
    expect(document.querySelector("[data-editor]")).not.toBeNull();
    let uninstall!: () => void;
    act(() => {
      uninstall = installWebOverlayPresentationGuard(guard);
      // The native creator can only run after installation returns.
      expect(guard).toHaveBeenCalledOnce();
    });
    try {
      expect(document.querySelector("[data-blocking-root]")).toBeNull();
      await act(async () => {});
      expect(document.querySelector("[data-blocking-root]")).not.toBeNull();
      view.unmount();
      await act(async () => {});
      expect(release).toHaveBeenCalledOnce();
    } finally {
      uninstall();
    }
  });

  it("reports failed registration admission once and ignores detached late failures", async () => {
    const replies: Array<(ready: boolean) => void> = [];
    const uninstall = installWebOverlayPresentationGuard(() => ({
      ready: new Promise<boolean>((resolve) => replies.push(resolve)),
      release: vi.fn(),
    }));
    const failed = vi.fn();
    const scope = document.createElement("div");
    document.body.append(scope);
    const view = renderHook(() =>
      useWebOverlayRegistration({
        active: true,
        layer: 40,
        onKeyDown: () => false,
        nativeBrowserOverlap: true,
        onPresentationFailed: failed,
      }),
    );
    try {
      act(() => view.result.current(scope));
      await act(async () => {
        replies[0]!(false);
      });
      expect(failed).toHaveBeenCalledOnce();
      act(() => view.result.current(null));
      act(() => view.result.current(scope));
      view.unmount();
      await act(async () => {
        replies[1]!(false);
      });
      expect(failed).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      uninstall();
    }
  });

  it("leaves command-center return focus with its existing caller owner", () => {
    const opener = document.createElement("button");
    const scope = document.createElement("div");
    const input = document.createElement("input");
    scope.append(input);
    document.body.append(opener, scope);
    opener.focus();
    const { result, rerender, unmount } = renderHook(
      ({ active }) =>
        useWebOverlayRegistration({
          active,
          layer: 40,
          onKeyDown: () => false,
          restoreFocusOnClose: false,
        }),
      { initialProps: { active: true } },
    );
    act(() => result.current(scope));
    input.focus();
    const restore = vi.spyOn(opener, "focus");
    rerender({ active: false });
    expect(restore).not.toHaveBeenCalled();
    unmount();
    expect(restore).not.toHaveBeenCalled();
  });
});
