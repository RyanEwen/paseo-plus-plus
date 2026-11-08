/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@/i18n/resources/en";
import type { DesktopBrowserExtensionsBridge } from "@/desktop/host";
import { BrowserExtensionsSection } from "./extensions-section";

const SMALL_CONTROL_MIN_HEIGHT = "28px";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", fallbackLng: "en", resources: { en: { translation: en } } });
});

afterEach(cleanup);

beforeEach(() => vi.stubGlobal("React", React));

const bridge: DesktopBrowserExtensionsBridge = {
  list: async () => [
    {
      id: "a".repeat(32),
      name: "Fixture extension",
      version: "1.0",
      source: "store",
      enabled: true,
    },
  ],
  actions: async () => [],
  setPinned: async () => {},
  onChanged: () => () => {},
  openPopup: async () => {},
  setEnabled: async () => {},
  remove: async () => {},
  loadUnpacked: async () => {},
  openStore: async () => {},
};

it("leaves row button height to the row convention and keeps the compact header action", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <BrowserExtensionsSection bridge={bridge} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  try {
    const labels = en.settings.general.browserExtensions;
    const disable = await view.findByRole("button", { name: labels.disable });
    const rowButtons = [
      disable,
      view.getByRole("button", { name: labels.remove }),
      view.getByRole("button", { name: labels.openStore }),
      view.getByRole("button", { name: labels.loadUnpacked }),
    ];
    for (const button of rowButtons) {
      expect(button.style.minHeight).not.toBe(SMALL_CONTROL_MIN_HEIGHT);
    }
    const refresh = view.getByRole("button", { name: labels.refresh });
    expect(refresh.style.minHeight).toBe(SMALL_CONTROL_MIN_HEIGHT);
  } finally {
    view.unmount();
    client.clear();
  }
});
