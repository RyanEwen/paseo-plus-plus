import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { AccentSection } from "./accent-section";

const saveState = vi.hoisted(() => ({
  settings: { accentColor: "default" },
  save: vi.fn(),
  pending: null as string | null,
  failed: null as string | null,
  isLoading: false,
  isEditingBlocked: false,
  error: null as Error | null,
}));

vi.mock("@/hooks/use-settings/use-settings-save", () => ({
  useSettingsSave: () => saveState,
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  // App sources compile against the classic JSX runtime, which expects React on the global.
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  saveState.failed = null;
  saveState.error = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("leaves a load failure to the surrounding section and locks the picker", () => {
  saveState.error = new Error("load failed");

  act(() => root.render(<AccentSection />));

  expect(container.textContent).not.toContain(i18n.t("paseoPlusPlus.loadFailed"));
  const blue = container.querySelector('[data-testid="accent-color-option-blue"]');
  expect(blue?.getAttribute("aria-disabled")).toBe("true");
});

it("shows a save failure on the picker", () => {
  saveState.failed = "accentColor";

  act(() => root.render(<AccentSection />));

  expect(container.textContent).toContain(i18n.t("paseoPlusPlus.saveFailed"));
});
