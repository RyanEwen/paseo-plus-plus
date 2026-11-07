import { describe, expect, it } from "vitest";
import { fitScreenshotViewport } from "./settings-example-fit";

describe("fitScreenshotViewport", () => {
  it("shows the whole screenshot when no region is given", () => {
    const fitted = fitScreenshotViewport({ width: 200, height: 100 }, 320);
    expect(fitted.viewport).toEqual({ left: 0, top: 0, width: 200, height: 100 });
    expect(fitted.scale).toBe(1);
    expect([fitted.frameWidth, fitted.frameHeight]).toEqual([200, 100]);
  });

  it("scales a wide region down to the frame and offsets the full image", () => {
    const fitted = fitScreenshotViewport(
      { width: 1440, height: 900, viewport: { left: 320, top: 100, width: 640, height: 400 } },
      320,
    );
    expect(fitted.scale).toBe(0.5);
    expect([fitted.frameWidth, fitted.frameHeight]).toEqual([320, 200]);
    expect([fitted.imageWidth, fitted.imageHeight]).toEqual([720, 450]);
    expect([fitted.imageLeft, fitted.imageTop]).toEqual([-160, -50]);
  });

  it("never enlarges a region narrower than the frame", () => {
    const fitted = fitScreenshotViewport(
      { width: 1440, height: 900, viewport: { left: 0, top: 0, width: 200, height: 120 } },
      320,
    );
    expect(fitted.scale).toBe(1);
    expect(fitted.frameWidth).toBe(200);
  });
});
