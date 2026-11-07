import { expect, type Page } from "@playwright/test";
import {
  defaultSidebarModeProfiles,
  SIDEBAR_VIEW_STORE_VERSION,
  type SidebarModePreferences,
} from "../../../src/stores/sidebar-mode-preferences";

interface MotionFrame {
  at: number;
  top: number;
  bottom: number;
  connected: boolean;
  sameNode: boolean;
  duration: number | null;
  group: string | null;
  /** Present when the probe observes a scroll viewport. */
  viewport?: { top: number; bottom: number; scrollTop: number };
}

interface MotionProbe {
  frames: MotionFrame[];
  paused: boolean;
  animation: Animation | null;
  stop: boolean;
}

type MotionWindow = Window & { __sidebarMotionProbe?: MotionProbe };

/**
 * Seed the motion setting and the sidebar view before app hydration.
 *
 * The sidebar view is written in the store's current persisted shape, so the app starts in the
 * requested grouping without taking the legacy migration path.
 *
 * @param workspaceSortMode the Status profile's workspace sort.
 */
export async function seedSidebarMotionPreferences({
  page,
  enabled,
  groupMode = "status",
  workspaceSortMode = "status",
}: {
  page: Page;
  enabled: boolean;
  groupMode?: "project" | "status";
  workspaceSortMode?: SidebarModePreferences["workspaceSortMode"];
}) {
  const modeProfiles = defaultSidebarModeProfiles();
  modeProfiles.status.workspaceSortMode = workspaceSortMode;
  await page.addInitScript(
    ({ motionEnabled, sidebarView }) => {
      if (!localStorage.getItem("@paseo:app-settings")) {
        localStorage.setItem(
          "@paseo:app-settings",
          JSON.stringify({
            workspaceTitleSource: "title",
            paseoPlusPlus: { sidebarWorkspaceTransitions: motionEnabled },
          }),
        );
      }
      localStorage.setItem("sidebar-view", JSON.stringify(sidebarView));
    },
    {
      motionEnabled: enabled,
      sidebarView: {
        version: SIDEBAR_VIEW_STORE_VERSION,
        state: { groupMode, workspaceSort: "manual", modeProfiles },
      },
    },
  );
}

/**
 * Observe painted geometry every frame without replacing browser or animation APIs.
 *
 * @param rowTestId the element to follow (a workspace row or a project header).
 * @param freeze pause the first running transition once, for pixel evidence of a middle frame.
 * @param viewportTestId also record this scroll viewport's bounds and scroll offset per frame.
 */
export async function startSidebarMotionProbe({
  page,
  rowTestId,
  freeze = false,
  viewportTestId,
}: {
  page: Page;
  rowTestId: string;
  freeze?: boolean;
  viewportTestId?: string;
}) {
  const options = { pauseForCapture: freeze, viewportTestId: viewportTestId ?? null };
  await page
    .getByTestId(rowTestId)
    .evaluate((row, { pauseForCapture, viewportTestId: viewportId }) => {
      const win = window as MotionWindow;
      const testId = row.getAttribute("data-testid");
      const probe: MotionProbe = { frames: [], paused: false, animation: null, stop: false };
      win.__sidebarMotionProbe = probe;
      const start = performance.now();
      const viewport = viewportId ? document.querySelector(`[data-testid="${viewportId}"]`) : null;
      function readViewport() {
        if (!viewport) return undefined;
        const bounds = viewport.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, scrollTop: viewport.scrollTop };
      }
      function capture() {
        if (probe.stop) return;
        const wrapper = row.closest("[data-position-transition]");
        const animation =
          wrapper?.getAnimations().find((candidate) => candidate.playState === "running") ?? null;
        const timing = animation?.effect?.getTiming();
        const duration = typeof timing?.duration === "number" ? timing.duration : null;
        if (
          pauseForCapture &&
          !probe.paused &&
          animation &&
          typeof animation.currentTime === "number" &&
          animation.currentTime >= 25
        ) {
          animation.pause();
          probe.animation = animation;
          probe.paused = true;
        }
        probe.frames.push({
          at: performance.now() - start,
          top: row.getBoundingClientRect().top,
          bottom: row.getBoundingClientRect().bottom,
          connected: row.isConnected,
          sameNode: document.querySelector(`[data-testid="${testId}"]`) === row,
          duration,
          group:
            row
              .closest('[data-testid^="sidebar-status-group-rows-"]')
              ?.getAttribute("data-testid") ?? null,
          viewport: readViewport(),
        });
        requestAnimationFrame(capture);
      }
      requestAnimationFrame(capture);
    }, options);
}

/** Resume the genuine paused transition after capturing its intermediate painted state. */
export async function resumeSidebarMotion(page: Page) {
  await page.evaluate(() => {
    const probe = (window as MotionWindow).__sidebarMotionProbe;
    if (!probe) throw new Error("Motion probe was not started");
    probe.animation?.play();
  });
}

/** Wait until a frozen probe (`freeze: true`) has paused the transition it observed. */
export async function expectSidebarMotionPaused(page: Page) {
  await expect
    .poll(() => page.evaluate(() => (window as MotionWindow).__sidebarMotionProbe?.paused))
    .toBe(true);
}

/** Stop the frame observer and return serializable motion and identity evidence. */
export async function stopSidebarMotionProbe(page: Page): Promise<MotionFrame[]> {
  return page.evaluate(() => {
    const probe = (window as MotionWindow).__sidebarMotionProbe;
    if (!probe) throw new Error("Motion probe was not started");
    probe.stop = true;
    return probe.frames;
  });
}
