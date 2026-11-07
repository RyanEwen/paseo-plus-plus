import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/i18n/resources/en";
import { SplitLayoutPicker } from "./split-layout-picker";

/** Smallest touch target edge, in CSS pixels, for compact split regions. */
const TOUCH_TARGET_MINIMUM = 44;
const OPEN_INTENT = { kind: "open", item: "Terminal" } as const;

const pickerI18n = createInstance();
beforeAll(async () => {
  await pickerI18n.init({ lng: "en", fallbackLng: "en", resources: { en: { translation: en } } });
});

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function regionRect(testID: string): DOMRect {
  const region = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (!region) {
    throw new Error(`Split region ${testID} is not rendered`);
  }
  return region.getBoundingClientRect();
}

describe("compact split regions", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("lays out every region at least 44px on both axes, with physical left before right", async () => {
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={pickerI18n}>
          <SplitLayoutPicker
            compact
            intent={OPEN_INTENT}
            onSelect={vi.fn()}
            testIDPrefix="region"
          />
        </I18nextProvider>,
      ),
    );
    await nextFrame();

    const regions = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(regions).toHaveLength(28);
    for (const region of regions) {
      const bounds = region.getBoundingClientRect();
      expect(bounds.width).toBeGreaterThanOrEqual(TOUCH_TARGET_MINIMUM);
      expect(bounds.height).toBeGreaterThanOrEqual(TOUCH_TARGET_MINIMUM);
    }

    const left = regionRect("region-left-70-30");
    const right = regionRect("region-right-70-30");
    expect(left.width).toBeCloseTo(154, 0);
    expect(right.width).toBeCloseTo(66, 0);
    // The gap between regions belongs to neither hit area.
    expect(right.left).toBeGreaterThanOrEqual(left.right);
  });
});
