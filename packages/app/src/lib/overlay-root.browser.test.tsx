import React, { type RefCallback } from "react";
import { PortalProvider } from "@gorhom/portal";
import { userEvent } from "vitest/browser";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  OVERLAY_Z,
  WEB_SURFACE_PLANE,
  hasOpenDomPopover,
  keyBelongsToDomPopover,
  useWebOverlayRegistration,
} from "./overlay-root";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function OverlayHarness({ active, showScope }: { active: boolean; showScope: boolean }) {
  const setScope = useWebOverlayRegistration({ active, layer: 20, onKeyDown: () => false });
  return showScope ? (
    <div data-testid="scope" ref={setScope as RefCallback<HTMLDivElement>} tabIndex={-1}>
      <input data-testid="overlay-input" />
    </div>
  ) : null;
}

describe("useWebOverlayRegistration in the browser", () => {
  let root: Root;
  let container: HTMLDivElement;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    container = document.createElement("div");
    opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener, container);
    root = createRoot(container);
    opener.focus();
  });

  afterEach(() => {
    root.unmount();
    document.body.replaceChildren();
  });

  async function renderHarness(active: boolean, showScope: boolean): Promise<void> {
    flushSync(() => {
      root.render(<OverlayHarness active={active} showScope={showScope} />);
    });
    await nextFrame();
  }

  it("skips focus restoration for active scope detach but restores focus when closing", async () => {
    await renderHarness(true, true);

    const input = document.querySelector<HTMLInputElement>('[data-testid="overlay-input"]');
    expect(input).toBeTruthy();
    input?.focus();
    await nextFrame();
    expect(document.activeElement).not.toBe(opener);

    const originalFocus = opener.focus.bind(opener);
    let openerFocusCalls = 0;
    opener.focus = () => {
      openerFocusCalls += 1;
      originalFocus();
    };

    await renderHarness(true, false);

    expect(openerFocusCalls).toBe(0);

    await renderHarness(false, false);

    expect(openerFocusCalls).toBe(1);
  });
});

describe("hasOpenDomPopover", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("is true only while a popover is shown", () => {
    const panel = document.createElement("div");
    panel.setAttribute("popover", "manual");
    document.body.append(panel);
    expect(hasOpenDomPopover()).toBe(false);
    panel.showPopover();
    expect(hasOpenDomPopover()).toBe(true);
    panel.hidePopover();
    expect(hasOpenDomPopover()).toBe(false);
  });
});

describe("Escape with a plugin popover open", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("leaves other keys to the shortcuts while a popover is open", () => {
    const panel = document.createElement("div");
    panel.setAttribute("popover", "manual");
    document.body.append(panel);
    panel.showPopover();
    expect(keyBelongsToDomPopover({ key: "Enter" })).toBe(false);
    expect(keyBelongsToDomPopover({ key: "Escape" })).toBe(true);
  });
});

// Animation timing is outside the portal placement and hit-testing regression.
vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-reanimated")>();
  return {
    ...actual,
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
  };
});

const DOCK_HOVER_TRIGGER_STYLE = {
  position: "fixed" as const,
  left: 180,
  top: 80,
  width: 20,
  height: 160,
};
const DOCK_PRESET_BUTTON_STYLE = { width: 120, height: 40 };

describe("HoverCard above the resident browser plane", () => {
  let root: Root;
  let container: HTMLDivElement;
  let opener: HTMLInputElement;
  let browserPlane: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    container = document.createElement("div");
    Object.assign(container.style, { position: "relative", zIndex: "0" });
    opener = document.createElement("input");
    document.body.append(opener, container);
    browserPlane = document.createElement("div");
    Object.assign(browserPlane.style, {
      position: "fixed",
      left: "201px",
      top: "0",
      right: "0",
      bottom: "0",
      zIndex: String(WEB_SURFACE_PLANE.browser),
      backgroundColor: "rgb(20, 30, 40)",
    });
    document.body.append(browserPlane);
    root = createRoot(container);
    opener.focus();
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  for (const parentLayer of [0, OVERLAY_Z.modal]) {
    it(`portals and clicks a hovered preset above the browser at parent layer ${parentLayer}`, async () => {
      const select = vi.fn();
      if (parentLayer === OVERLAY_Z.modal) {
        const modalPlane = document.createElement("div");
        Object.assign(modalPlane.style, {
          position: "fixed",
          left: "201px",
          top: "0",
          right: "0",
          bottom: "0",
          zIndex: String(OVERLAY_Z.modal),
          pointerEvents: "auto",
        });
        getOverlayRoot().append(modalPlane);
      }
      flushSync(() =>
        root.render(
          <PortalProvider>
            <OverlayLayerProvider layer={parentLayer}>
              <HoverCard>
                <HoverCardTrigger
                  style={DOCK_HOVER_TRIGGER_STYLE}
                  accessibilityLabel="Dock ratio trigger"
                >
                  <span>Divider</span>
                </HoverCardTrigger>
                <HoverCardContent placement="right" anchor="pointer" testID="dock-hover-presets">
                  <button type="button" onClick={select} style={DOCK_PRESET_BUTTON_STYLE}>
                    60/40
                  </button>
                </HoverCardContent>
              </HoverCard>
            </OverlayLayerProvider>
          </PortalProvider>,
        ),
      );
      const trigger = container.querySelector<HTMLElement>('[aria-label="Dock ratio trigger"]');
      expect(trigger).not.toBeNull();
      await userEvent.hover(trigger!);
      await expect
        .poll(() => document.querySelector('[data-testid="dock-hover-presets"]'))
        .not.toBeNull();
      const card = document.querySelector<HTMLElement>('[data-testid="dock-hover-presets"]')!;
      expect(card.closest("#overlay-root")).toBe(getOverlayRoot());
      expect(getOverlayRoot().parentElement).toBe(document.body);
      expect(card.parentElement?.style.zIndex).toBe(String(parentLayer + OVERLAY_Z.floating));
      expect(document.activeElement).toBe(opener);
      const button = card.querySelector("button")!;
      await expect.poll(() => button.getBoundingClientRect().left).toBeGreaterThan(201);
      const bounds = button.getBoundingClientRect();
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      const browserBounds = browserPlane.getBoundingClientRect();
      expect(x).toBeGreaterThan(browserBounds.left);
      expect(x).toBeLessThan(browserBounds.right);
      expect(button.contains(document.elementFromPoint(x, y))).toBe(true);
      await userEvent.click(button);
      expect(select).toHaveBeenCalledTimes(1);
      await userEvent.keyboard("{Escape}");
      await expect
        .poll(() => document.querySelector('[data-testid="dock-hover-presets"]'))
        .toBeNull();
    });
  }
});
