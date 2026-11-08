import {
  publishMeasuredNativeNearBottom,
  createNativeViewportLifetime,
  createNativeViewportMetrics,
  resolveNativeMotionOwner,
  resolveNativeMeasurementOwner,
  nativeOriginalTop,
  nativeStickyTranslation,
} from "./native-actual-row-model";
import { describe, expect, it, vi } from "vitest";

type NativeBottomMeasurement = Parameters<typeof publishMeasuredNativeNearBottom>[0]["metrics"];

function createNativeBottomMeasurement(): NativeBottomMeasurement {
  return {
    containerKey: "native-virtualized",
    contentHeight: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null,
    contentMeasuredForKey: null,
  };
}

describe("native viewport lifetime", () => {
  it("rejects delayed callbacks from an old list instead of stamping the newly held list", () => {
    const oldOrigin = createNativeViewportLifetime();
    const oldViewport = {};
    expect(oldOrigin.attach(oldViewport)).toBe(true);
    expect(oldOrigin.isCurrent(oldOrigin, oldViewport)).toBe(true);

    const nextOrigin = createNativeViewportLifetime();
    const nextViewport = {};
    expect(oldOrigin.release(oldViewport)).toBe(true);
    expect(nextOrigin.attach(nextViewport)).toBe(true);

    // Event closures retain oldOrigin even when the owner now holds nextViewport.
    expect(oldOrigin.isCurrent(nextOrigin, nextViewport)).toBe(false);
    expect(nextOrigin.isCurrent(nextOrigin, nextViewport)).toBe(true);
    expect(nextOrigin.isCurrent(nextOrigin, oldViewport)).toBe(false);
  });

  it("requires the originating list component even if another owner holds the same object", () => {
    const viewport = {};
    const original = createNativeViewportLifetime();
    const replacement = createNativeViewportLifetime();
    expect(original.attach(viewport)).toBe(true);
    expect(replacement.attach(viewport)).toBe(true);
    expect(original.isCurrent(replacement, viewport)).toBe(false);
    expect(replacement.isCurrent(replacement, viewport)).toBe(true);
  });

  it("retires a detached origin without allowing it to acquire a different physical list", () => {
    const origin = createNativeViewportLifetime();
    const viewport = {};
    const other = {};
    expect(origin.attach(viewport)).toBe(true);
    expect(origin.release(other)).toBe(false);
    expect(origin.isCurrent(origin, viewport)).toBe(true);
    expect(origin.release(viewport)).toBe(true);
    expect(origin.isCurrent(origin, viewport)).toBe(false);
    expect(origin.attach(other)).toBe(false);
    expect(origin.isCurrent(origin, other)).toBe(false);

    // React may repeat a callback ref for the same physical instance.
    expect(origin.attach(viewport)).toBe(true);
    expect(origin.isCurrent(origin, viewport)).toBe(true);
  });

  it("clears the old observed bottom offset before a new viewport measures current content", () => {
    const previous = createNativeViewportMetrics();
    previous.contentHeight = 1800;
    previous.viewportHeight = 600;
    previous.offsetY = 1200;
    previous.viewportMeasuredForKey = previous.containerKey;
    previous.contentMeasuredForKey = previous.containerKey;
    const current = createNativeViewportMetrics();
    const publish = vi.fn<(nearBottom: boolean) => void>();

    expect(current.offsetY).toBe(0);
    expect(current.viewportMeasuredForKey).toBeNull();
    expect(current.contentMeasuredForKey).toBeNull();
    publishMeasuredNativeNearBottom({ metrics: current, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();

    current.viewportHeight = 600;
    current.contentHeight = 1800;
    current.viewportMeasuredForKey = current.containerKey;
    current.contentMeasuredForKey = current.containerKey;
    publishMeasuredNativeNearBottom({ metrics: current, threshold: 32, publish });
    expect(publish).toHaveBeenCalledExactlyOnceWith(false);
    expect(current.offsetY).toBe(0);
    expect(previous.offsetY).toBe(1200);
  });
});

describe("native measured near-bottom publication", () => {
  it("reveals an off-bottom list when content follows layout without a scroll event", () => {
    const metrics = createNativeBottomMeasurement();
    const publish = vi.fn<(nearBottom: boolean) => void>();
    metrics.viewportHeight = 600;
    metrics.viewportMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();

    metrics.contentHeight = 1800;
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenCalledExactlyOnceWith(false);
    expect(metrics.offsetY).toBe(0);
  });

  it("reveals an off-bottom list when layout follows content without a scroll event", () => {
    const metrics = createNativeBottomMeasurement();
    const publish = vi.fn<(nearBottom: boolean) => void>();
    metrics.contentHeight = 1800;
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();

    metrics.viewportHeight = 600;
    metrics.viewportMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenCalledExactlyOnceWith(false);
    expect(metrics.offsetY).toBe(0);
  });

  it("withholds incomplete or stale-container measurements until both are current and positive", () => {
    const metrics = createNativeBottomMeasurement();
    const publish = vi.fn<(nearBottom: boolean) => void>();
    metrics.viewportMeasuredForKey = metrics.containerKey;
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    metrics.viewportHeight = 600;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    metrics.contentHeight = 1800;
    metrics.viewportHeight = 0;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();

    metrics.viewportHeight = 600;
    metrics.containerKey = "rebound-container";
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    metrics.viewportMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).not.toHaveBeenCalled();
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("publishes fitting content and current offsets using the existing bottom threshold", () => {
    const metrics = createNativeBottomMeasurement();
    const publish = vi.fn<(nearBottom: boolean) => void>();
    metrics.viewportHeight = 600;
    metrics.contentHeight = 400;
    metrics.viewportMeasuredForKey = metrics.containerKey;
    metrics.contentMeasuredForKey = metrics.containerKey;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenLastCalledWith(true);

    metrics.contentHeight = 1800;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenLastCalledWith(false);
    metrics.offsetY = 1167;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenLastCalledWith(false);
    metrics.offsetY = 1168;
    publishMeasuredNativeNearBottom({ metrics, threshold: 32, publish });
    expect(publish).toHaveBeenLastCalledWith(true);
    expect(publish).toHaveBeenCalledTimes(4);
  });
});

describe("actual native motion owner topology", () => {
  it("uses the actual unshifted child viewport as its stationary measurement edge", () => {
    const mode = resolveNativeMotionOwner({
      allowStandalone: true,
      hasMotion: false,
      hasStationaryClip: false,
    });
    expect(mode).toBe("standalone");
    const viewport = { top: 20 };
    const owner = resolveNativeMeasurementOwner(mode, viewport, null)!;
    expect(owner.viewport).toBe(viewport);
    expect(owner.clip).toBe(viewport);
    expect(
      nativeOriginalTop({
        layout: 1250,
        offset: 1000,
        listTop: owner.viewport.top,
        clipTop: owner.clip.top,
      }),
    ).toBe(250);
    expect(nativeStickyTranslation({ y: 1000, layout: 1250, height: 53, next: null })).toBe(0);
  });
  it("retains the real dock measurement owner and physical K even when a child is eligible for standalone", () => {
    const mode = resolveNativeMotionOwner({
      allowStandalone: true,
      hasMotion: true,
      hasStationaryClip: true,
    });
    expect(mode).toBe("docked");
    const viewport = { top: -200 };
    const clip = { top: 100 };
    const owner = resolveNativeMeasurementOwner(mode, viewport, clip)!;
    expect(owner.viewport).toBe(viewport);
    expect(owner.clip).toBe(clip);
    expect(
      nativeOriginalTop({
        layout: 1250,
        offset: 1000,
        listTop: owner.viewport.top,
        clipTop: owner.clip.top,
      }),
    ).toBe(-50);
    expect(nativeStickyTranslation({ y: 1000 + 300, layout: 1250, height: 53, next: null })).toBe(
      50,
    );
  });
  it("rejects partial/missing dock contracts and waits for actual refs rather than guessing zero", () => {
    expect(() =>
      resolveNativeMotionOwner({
        allowStandalone: false,
        hasMotion: false,
        hasStationaryClip: false,
      }),
    ).toThrow("owners must match");
    expect(() =>
      resolveNativeMotionOwner({
        allowStandalone: true,
        hasMotion: true,
        hasStationaryClip: false,
      }),
    ).toThrow("owners must match");
    expect(() =>
      resolveNativeMotionOwner({
        allowStandalone: true,
        hasMotion: false,
        hasStationaryClip: true,
      }),
    ).toThrow("owners must match");
    expect(resolveNativeMeasurementOwner("docked", { top: -200 }, null)).toBeNull();
    expect(resolveNativeMeasurementOwner("standalone", null, null)).toBeNull();
  });
});
