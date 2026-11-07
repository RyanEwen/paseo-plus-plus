/** A region of a screenshot, in original screenshot pixels. */
export interface ScreenshotViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How a screenshot region is drawn inside a frame of limited width. */
export interface FittedScreenshot {
  /** The region shown, defaulting to the whole screenshot. */
  viewport: ScreenshotViewport;
  /** Display pixels per original screenshot pixel; never above 1. */
  scale: number;
  /** Size of the visible frame, in display pixels. */
  frameWidth: number;
  frameHeight: number;
  /** Size and offset of the full screenshot inside the frame, in display pixels. */
  imageWidth: number;
  imageHeight: number;
  imageLeft: number;
  imageTop: number;
}

/**
 * Fit a screenshot's region into `maxWidth` display pixels without enlarging it.
 *
 * The whole screenshot is drawn and offset so only the region shows through the frame, which
 * keeps the bundled capture intact instead of cropping the asset.
 */
export function fitScreenshotViewport(
  image: { width: number; height: number; viewport?: ScreenshotViewport },
  maxWidth: number,
): FittedScreenshot {
  const viewport = image.viewport ?? { left: 0, top: 0, width: image.width, height: image.height };
  const frameWidth = Math.min(maxWidth, viewport.width);
  const scale = frameWidth / viewport.width;
  return {
    viewport,
    scale,
    frameWidth,
    frameHeight: scale * viewport.height,
    imageWidth: scale * image.width,
    imageHeight: scale * image.height,
    imageLeft: -scale * viewport.left,
    imageTop: -scale * viewport.top,
  };
}
