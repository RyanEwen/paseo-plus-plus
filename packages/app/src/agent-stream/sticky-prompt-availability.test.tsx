// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stickyPromptsSupported, useStickyPromptsEnabled } from "./sticky-prompt-availability";

const layout = vi.hoisted(() => ({ compact: false, setting: true }));

vi.mock("@/constants/platform", () => ({ isNative: false, isWeb: true }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => layout.compact }));
vi.mock("@/hooks/use-settings", () => ({
  useSettings: (select: (settings: { paseoPlusPlus: { stickyUserPrompts: boolean } }) => boolean) =>
    select({ paseoPlusPlus: { stickyUserPrompts: layout.setting } }),
}));

describe("sticky prompt availability", () => {
  beforeEach(() => {
    layout.compact = false;
    layout.setting = true;
  });

  it("supports desktop layouts only", () => {
    expect(stickyPromptsSupported({ native: false, compact: false })).toBe(true);
    expect(stickyPromptsSupported({ native: true, compact: false })).toBe(false);
    expect(stickyPromptsSupported({ native: false, compact: true })).toBe(false);
  });

  it("follows the setting on a desktop layout", () => {
    expect(renderHook(useStickyPromptsEnabled).result.current).toBe(true);
    layout.setting = false;
    expect(renderHook(useStickyPromptsEnabled).result.current).toBe(false);
  });

  it("is off in a compact layout even with the setting on", () => {
    layout.compact = true;

    expect(renderHook(useStickyPromptsEnabled).result.current).toBe(false);
  });
});
