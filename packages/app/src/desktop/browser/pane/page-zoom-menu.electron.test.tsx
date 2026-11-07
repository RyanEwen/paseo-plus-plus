/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@/i18n/resources/en";
import {
  ensureResidentBrowserWebview,
  clearResidentBrowserWebviewsForTests,
} from "@/desktop/browser/resident-webviews";
import { PageZoomMenu } from "./page-zoom-menu.electron";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", fallbackLng: "en", resources: { en: { translation: en } } });
});

afterEach(cleanup);

beforeEach(() => vi.stubGlobal("React", React));

const triggerStyle = () => ({});
const tooltipTextStyle = {};

it("reads guest page zoom on open, changes and resets it without changing application zoom", async () => {
  const guest = ensureResidentBrowserWebview({
    browserId: "menu-zoom",
    workspaceId: "workspace",
    url: "https://example.com",
    profileHost: { profilePartition: "persist:test-zoom", registerAttachedBrowser: async () => {} },
  });
  if (!guest) throw new Error("Expected fixture guest");
  let zoom = 1.25;
  const nativeSet = vi.fn((factor: number) => {
    zoom = factor;
  });
  Object.defineProperties(guest, {
    getZoomFactor: { value: () => zoom },
    setZoomFactor: { value: nativeSet },
  });
  const getWebview = vi.fn(() => guest);
  const view = render(
    <I18nextProvider i18n={i18n}>
      <PageZoomMenu
        browserId="menu-zoom"
        getWebview={getWebview}
        triggerStyle={triggerStyle}
        tooltipTextStyle={tooltipTextStyle}
      />
    </I18nextProvider>,
  );
  try {
    const trigger = view.getByRole("button", { name: "Page zoom" });
    expect(trigger.style.minWidth).toBe("48px");
    fireEvent.click(trigger);
    fireEvent.click(await view.findByRole("menuitem", { name: "150%" }));
    expect(nativeSet).toHaveBeenLastCalledWith(1.5);
    expect(zoom).toBe(1.5);
    fireEvent.click(view.getByRole("menuitem", { name: "100%" }));
    expect(nativeSet).toHaveBeenLastCalledWith(1);
    expect(nativeSet).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    clearResidentBrowserWebviewsForTests();
  }
});
