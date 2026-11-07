import { describe, expect, it } from "vitest";
import {
  resolveStreamKeyboardInset,
  resolveDockReservation,
  shouldReconcileHiddenKeyboardEnd,
  resolveKeyboardLift,
  resolveKeyboardShift,
  reserveKeyboardLayoutShift,
} from "./policy";

describe("keyboard layout reservation", () => {
  it("reserves the opening destination before motion and releases it only after closing", () => {
    const opened = reserveKeyboardLayoutShift({ current: 0, target: 308, phase: "start" });
    expect(opened).toBe(308);
    const closing = reserveKeyboardLayoutShift({ current: opened, target: 0, phase: "start" });
    expect(closing).toBe(308);
    expect(reserveKeyboardLayoutShift({ current: closing, target: 0, phase: "end" })).toBe(0);
  });

  it("keeps enough space when a resize or reversal interrupts keyboard motion", () => {
    const resizing = reserveKeyboardLayoutShift({ current: 308, target: 250, phase: "start" });
    expect(resizing).toBe(308);
    const reversing = reserveKeyboardLayoutShift({
      current: resizing,
      target: 340,
      phase: "start",
    });
    expect(reversing).toBe(340);
    expect(reserveKeyboardLayoutShift({ current: reversing, target: 340, phase: "end" })).toBe(340);
  });
});

describe("resolveStreamKeyboardInset", () => {
  it("uses the native scroll inset on iOS without changing content size", () => {
    expect(resolveStreamKeyboardInset({ platform: "ios", settledShift: 311 })).toEqual({
      contentContainerPaddingBottom: 0,
      contentInset: { bottom: 311 },
    });
  });

  it("keeps Android's exact content-container padding behavior", () => {
    expect(resolveStreamKeyboardInset({ platform: "android", settledShift: 311 })).toEqual({
      contentContainerPaddingBottom: 311,
      contentInset: undefined,
    });
  });

  it("does not expose a negative inset", () => {
    expect(resolveStreamKeyboardInset({ platform: "ios", settledShift: -1 })).toEqual({
      contentContainerPaddingBottom: 0,
      contentInset: { bottom: 0 },
    });
  });
});

describe("resolveKeyboardShift", () => {
  it("keeps the existing open-keyboard offset behavior", () => {
    expect(
      resolveKeyboardShift({
        rawKeyboardHeight: 320,
        keyboardProgress: 1,
        bottomInset: 24,
        isIos: false,
        iosMinHeight: 120,
      }),
    ).toBe(296);
  });

  it("treats progress zero as closed even when Android reports a stale height", () => {
    expect(
      resolveKeyboardShift({
        rawKeyboardHeight: 320,
        keyboardProgress: 0,
        bottomInset: 24,
        isIos: false,
        iosMinHeight: 120,
      }),
    ).toBe(0);
  });

  it("still ignores small iOS accessory bar reports", () => {
    expect(
      resolveKeyboardShift({
        rawKeyboardHeight: 80,
        keyboardProgress: 1,
        bottomInset: 0,
        isIos: true,
        iosMinHeight: 120,
      }),
    ).toBe(0);
  });
});

describe("resolveKeyboardLift", () => {
  it("lifts a docked view by the whole shift", () => {
    expect(resolveKeyboardLift({ shift: 302, enabled: true, bottomClearance: 0 })).toBe(302);
  });

  it("lets the keyboard fill a centered form's clearance before lifting it", () => {
    expect(resolveKeyboardLift({ shift: 403, enabled: true, bottomClearance: 267 })).toBe(136);
    expect(resolveKeyboardLift({ shift: 403, enabled: true, bottomClearance: 455 })).toBe(0);
  });

  it("keeps a disabled view in place", () => {
    expect(resolveKeyboardLift({ shift: 302, enabled: false, bottomClearance: 0 })).toBe(0);
  });
});

describe("shouldReconcileHiddenKeyboardEnd", () => {
  it("closes stale iOS keyboard state without letting a late visible end resurrect it", () => {
    expect(
      shouldReconcileHiddenKeyboardEnd({
        height: 0,
        progress: 0,
      }),
    ).toBe(true);
    expect(
      shouldReconcileHiddenKeyboardEnd({
        height: 320,
        progress: 1,
      }),
    ).toBe(false);
  });
});

describe("actual chronological dock reservation", () => {
  it("reserves a small actual iOS accessory displacement without the provider threshold", () => {
    expect(resolveDockReservation({ height: 90, progress: 1, bottomInset: 34, clearance: 0 })).toBe(
      56,
    );
    expect(
      resolveDockReservation({ height: 90, progress: 1, bottomInset: 34, clearance: 20 }),
    ).toBe(36);
  });
  it("uses the identical platform endpoint while preserving the closing reservation", () => {
    const open = resolveDockReservation({
      height: 342,
      progress: 1,
      bottomInset: 34,
      clearance: 0,
    });
    expect(open).toBe(308);
    expect(
      reserveKeyboardLayoutShift({
        current: open,
        target: resolveDockReservation({ height: 0, progress: 0, bottomInset: 34, clearance: 0 }),
        phase: "start",
      }),
    ).toBe(308);
    expect(reserveKeyboardLayoutShift({ current: open, target: 0, phase: "end" })).toBe(0);
  });
  it("does not reserve safe area twice or create a negative leading extent", () => {
    expect(
      resolveDockReservation({ height: -342, progress: 1, bottomInset: 34, clearance: 0 }),
    ).toBe(308);
    expect(resolveDockReservation({ height: 20, progress: 1, bottomInset: 34, clearance: 0 })).toBe(
      0,
    );
    expect(
      resolveDockReservation({ height: 342, progress: 0, bottomInset: 34, clearance: 0 }),
    ).toBe(0);
  });
});
