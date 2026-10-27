import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect } from "../fixtures";

/** Shared compact geometry now belongs to the one mounted actual message. */
export async function expectSingleLineStickyGeometry(row: Locator) {
  return expectActualSingleLineGeometry(row);
}

/** Record usable allocation and painted prompt prefix, including attachment-only copies. */
export async function expectInlineStickyAttachmentCount(
  sticky: Locator,
  count: string,
  prompt: string,
  testInfo: TestInfo,
) {
  const summary = sticky.getByText(count, { exact: true });
  await expect(summary).toBeVisible();
  const geometry = await measureInlineAttachmentAllocation(sticky, count, prompt);
  const label = prompt ? "text-and-attachments" : "attachment-only";
  await testInfo.attach(`compact-allocation-${label}`, {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });
  const viewport = sticky.page().viewportSize();
  expect(viewport).not.toBeNull();
  const bubble = geometry.bubble!.bounds;
  const capture = {
    x: Math.max(0, bubble.left),
    y: Math.max(0, bubble.top),
    width: Math.min(viewport!.width, bubble.right) - Math.max(0, bubble.left),
    height: Math.min(viewport!.height, bubble.bottom) - Math.max(0, bubble.top),
  };
  expect(capture.width).toBeGreaterThan(0);
  expect(capture.height).toBeGreaterThan(0);
  await sticky.page().screenshot({
    path: testInfo.outputPath(`compact-allocation-${label}.png`),
    clip: capture,
    animations: "disabled",
  });
  expect(await measureInlineAttachmentAllocation(sticky, count, prompt)).toEqual(geometry);
  await expect(sticky).toHaveAttribute("data-prompt-pinned", "true");
  expect(geometry.count!.bounds.width).toBeGreaterThan(0);
  if (!prompt) {
    expect(geometry.text).toBeNull();
    // A truncated count can use the whole cell instead of reserving an empty text half.
    if (geometry.count!.scrollWidth > geometry.count!.clientWidth) {
      expect(geometry.count!.bounds.width).toBeCloseTo(geometry.cell!.bounds.width, 0);
    }
    return;
  }
  expect(geometry.text!.textContent).toBe(prompt);
  expect(geometry.text!.bounds.width).toBeGreaterThan(0);
  expect(geometry.prefixBounds!.width).toBeGreaterThan(0);
  expect(geometry.prefixBounds!.left).toBeGreaterThanOrEqual(geometry.text!.bounds.left);
  expect(geometry.prefixBounds!.top).toBeGreaterThanOrEqual(geometry.text!.bounds.top);
  expect(geometry.prefixBounds!.bottom).toBeLessThanOrEqual(geometry.text!.bounds.bottom);
  expect(geometry.count!.bounds.x + geometry.count!.bounds.width).toBeLessThanOrEqual(
    geometry.text!.bounds.x,
  );
  expect(
    Math.abs(
      geometry.count!.bounds.y +
        geometry.count!.bounds.height / 2 -
        geometry.textClip!.bounds.y -
        geometry.textClip!.bounds.height / 2,
    ),
  ).toBeLessThanOrEqual(1);
  expect(geometry.prefixBounds!.right).toBeLessThanOrEqual(geometry.text!.bounds.right);
  const prefixInk = await countPaintedPromptPrefix(sticky, geometry.prefixBounds!);
  await testInfo.attach("compact-prompt-prefix-ink", {
    body: JSON.stringify({ prefix: geometry.prefix, ink: prefixInk }),
    contentType: "application/json",
  });
  expect(prefixInk).toBeGreaterThan(0);
}

/** Snapshot actual compact allocation before any assertions can end the case. */
async function measureInlineAttachmentAllocation(
  sticky: Locator,
  countLabel: string,
  promptText: string,
) {
  return await sticky.evaluate(
    (node, { count, prompt }) => {
      function rectangle(bounds: DOMRect) {
        const { x, y, width, height, top, right, bottom, left } = bounds;
        return { x, y, width, height, top, right, bottom, left };
      }
      function describe(element: Element | null) {
        if (!element) return null;
        const style = getComputedStyle(element);
        return {
          bounds: rectangle(element.getBoundingClientRect()),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          textContent: element.textContent,
          overflow: style.overflow,
          whiteSpace: style.whiteSpace,
          lineClamp: style.webkitLineClamp,
        };
      }
      const countNode = Array.from(node.querySelectorAll('[role="link"]')).find(
        (element) => element.textContent === count,
      )!;
      const text = node.querySelector("[data-message-text=true]");
      const prefix = Array.from(prompt)[0] ?? "";
      let prefixBounds: ReturnType<typeof rectangle> | null = null;
      if (text && prefix) {
        const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
        const first = walker.nextNode()!;
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(first, prefix.length);
        prefixBounds = rectangle(range.getBoundingClientRect());
      }
      const disclosure = node.querySelector('[data-testid="user-message-disclosure"]');
      return {
        bubble: describe(node.querySelector('[data-testid="user-message-bubble"]')),
        count: describe(countNode),
        cell: describe(countNode.parentElement),
        text: describe(text),
        // TextPreview preserves the full natural text node and clips its first line.
        // Compare the visible cell, rather than the offscreen continuation's height.
        textClip: describe(text?.closest('[data-testid="text-preview-clip"]') ?? null),
        disclosure: describe(disclosure),
        touchParent: describe(disclosure?.parentElement ?? null),
        prefix,
        prefixBounds,
      };
    },
    { count: countLabel, prompt: promptText },
  );
}

/** Count foreground in the first character's painted region, rather than trusting DOM text. */
async function countPaintedPromptPrefix(
  sticky: Locator,
  prefixRectangle: { left: number; right: number; top: number; bottom: number },
) {
  const text = sticky.locator("[data-message-text=true]");
  const prefixLength = await text.evaluate(
    (node) => Array.from(node.textContent ?? "")[0]?.length ?? 0,
  );
  const frame = await captureActualPromptFrame(text.page(), text, prefixLength);
  expect(frame.prefix).toEqual({
    left: prefixRectangle.left,
    right: prefixRectangle.right,
    top: prefixRectangle.top,
    bottom: prefixRectangle.bottom,
  });
  expect(frame.prefix!.left).toBeGreaterThanOrEqual(frame.capture.x);
  expect(frame.prefix!.right).toBeLessThanOrEqual(frame.capture.x + frame.capture.width);
  expect(frame.prefix!.top).toBeGreaterThanOrEqual(frame.capture.y);
  expect(frame.prefix!.bottom).toBeLessThanOrEqual(frame.capture.y + frame.capture.height);
  return await text.evaluate(
    async (element, { base64, prefixBounds, capture }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      const foreground = getComputedStyle(element).color.match(/\d+/g)!.slice(0, 3).map(Number);
      const foregroundBrightness = foreground.reduce((sum, value) => sum + value, 0) / 3;
      const backgroundBrightness = (data[0]! + data[1]! + data[2]!) / 3;
      const threshold = foregroundBrightness + (backgroundBrightness - foregroundBrightness) * 0.35;
      const scaleX = image.width / capture.width;
      const scaleY = image.height / capture.height;
      const left = Math.max(0, Math.floor((prefixBounds.left - capture.x) * scaleX));
      const right = Math.min(image.width, Math.ceil((prefixBounds.right - capture.x) * scaleX));
      const top = Math.max(0, Math.floor((prefixBounds.top - capture.y) * scaleY));
      const bottom = Math.min(image.height, Math.ceil((prefixBounds.bottom - capture.y) * scaleY));
      let ink = 0;
      for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
          const offset = (y * image.width + x) * 4;
          const brightness = (data[offset]! + data[offset + 1]! + data[offset + 2]!) / 3;
          if (
            foregroundBrightness < backgroundBrightness
              ? brightness < threshold
              : brightness > threshold
          )
            ink += 1;
        }
      }
      return ink;
    },
    {
      base64: frame.pixels.toString("base64"),
      prefixBounds: frame.prefix!,
      capture: frame.capture,
    },
  );
}

/** Ordinary rows expose their entire real text and bubble, with no sticky disclosure. */
export async function expectActualExpandedGeometry(row: Locator) {
  await expect(row).toHaveAttribute("data-prompt-pinned", "false");
  const geometry = await row.getByTestId("user-message-text").evaluate((text) => {
    const clip = text.closest('[data-testid="text-preview-clip"]')!;
    const bubble = text.closest('[data-testid="user-message-bubble"]')!;
    const style = getComputedStyle(bubble);
    const textHeight = text.getBoundingClientRect().height;
    return {
      textHeight,
      clipHeight: clip.getBoundingClientRect().height,
      textClientHeight: text.clientHeight,
      textScrollHeight: text.scrollHeight,
      bubbleHeight: bubble.getBoundingClientRect().height,
      expectedBubbleHeight:
        textHeight + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
    };
  });
  expect(geometry.textHeight).toBeGreaterThan(0);
  expect(geometry.clipHeight).toBe(geometry.textHeight);
  expect(geometry.textScrollHeight).toBe(geometry.textClientHeight);
  expect(geometry.bubbleHeight).toBeCloseTo(geometry.expectedBubbleHeight, 0);
  await expect(row.getByTestId("user-message-disclosure")).toHaveCount(0);
  await expect(row.getByTestId("text-preview-measurement")).toHaveCount(0);
}

/** Actual row measurements; no copied preview or hidden measurement ancestor. */
export async function expectActualSingleLineGeometry(row: Locator) {
  const geometry = await row.getByTestId("user-message-text").evaluate((text) => {
    const clip = text.closest('[data-testid="text-preview-clip"]')!;
    const bounds = clip.getBoundingClientRect();
    const bubble = text.closest('[data-testid="user-message-bubble"]')!;
    const message = text.closest('[data-testid="user-message"]')!;
    const controls = message.querySelector('[data-testid="user-message-trailing-row"]')!;
    const bubbleBounds = bubble.getBoundingClientRect();
    let cell = clip.parentElement;
    while (cell && cell !== bubble && Number.parseFloat(getComputedStyle(cell).paddingTop) === 0)
      cell = cell.parentElement;
    const padding = cell && cell !== bubble ? getComputedStyle(cell) : null;
    const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
    return {
      height: bubbleBounds.height,
      clipHeight: bounds.height,
      lineHeight,
      controlsOffset: controls.getBoundingClientRect().top - bubbleBounds.top,
      expectedHeight: padding
        ? lineHeight +
          Number.parseFloat(padding.paddingTop) +
          Number.parseFloat(padding.paddingBottom)
        : null,
    };
  });
  expect(geometry.clipHeight).toBeCloseTo(geometry.lineHeight, 0);
  expect(geometry.expectedHeight).not.toBeNull();
  expect(geometry.height).toBeCloseTo(geometry.expectedHeight!, 0);
  const disclosure = row.getByTestId("user-message-disclosure");
  if (await disclosure.count()) {
    const size = await disclosure.boundingBox();
    expect(size!.width).toBeGreaterThanOrEqual(44);
    expect(size!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(row.getByTestId("text-preview-measurement")).toHaveCount(0);
  const actions = row.getByTestId("user-message-trailing-row");
  const allocation = await actions.evaluate((node) => {
    const style = getComputedStyle(node);
    const bounds = node.getBoundingClientRect();
    const content = Array.from(
      node.querySelectorAll('[data-testid="user-message-timestamp"],button,[role="button"]'),
    );
    return {
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
      contained: content.map((child) => {
        const rect = child.getBoundingClientRect();
        return (
          rect.left >= bounds.left + 8 &&
          rect.right <= bounds.right - 8 &&
          rect.top >= bounds.top + 8 &&
          rect.bottom <= bounds.bottom - 8
        );
      }),
    };
  });
  expect(allocation.padding).toEqual(["8px", "8px", "8px", "8px"]);
  expect(allocation.contained.length).toBeGreaterThan(0);
  expect(allocation.contained.every(Boolean)).toBe(true);
  return geometry;
}

export async function expectActualRowUnpinned(
  page: import("@playwright/test").Page,
  row: Locator,
  testInfo: TestInfo,
) {
  const viewport = page.getByTestId("agent-chat-scroll");
  const geometry = await row.evaluate((node) => {
    const scroll = node.closest('[data-testid="agent-chat-scroll"]')!;
    return {
      row: node.getBoundingClientRect().toJSON(),
      viewport: scroll.getBoundingClientRect().toJSON(),
      scrollTop: scroll.scrollTop,
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      pinned: node.getAttribute("data-prompt-pinned"),
    };
  });
  await testInfo.attach("actual-row-before-pin", {
    body: JSON.stringify(geometry),
    contentType: "application/json",
  });
  await expect(viewport).toBeVisible();
  expect(geometry.clientHeight).toBeGreaterThan(0);
  expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
  expect(geometry.row.top).toBeGreaterThan(geometry.viewport.top);
  await expect(row).toHaveAttribute("data-prompt-pinned", "false");
}

export async function expectActualFindVisible(row: Locator, expectedStart: number) {
  let observedStart: number | null = null;
  await expect
    .poll(async () => {
      observedStart = await row.evaluate((node, start) => {
        const outer = node.closest('[data-testid="agent-chat-scroll"]')!;
        const body = node.querySelector('[data-testid="user-message-body-scroll"]')!;
        const text = node.querySelector('[data-testid="user-message-text"]')!;
        const clip = text.closest('[data-testid="text-preview-clip"]')!;
        function clientBounds(element: Element) {
          const bounds = element.getBoundingClientRect();
          return {
            left: bounds.left + element.clientLeft,
            top: bounds.top + element.clientTop,
            right: bounds.left + element.clientLeft + element.clientWidth,
            bottom: bounds.top + element.clientTop + element.clientHeight,
          };
        }
        const visible = [outer, body, clip].map(clientBounds);
        const selected = Array.from(CSS.highlights.entries())
          .filter(([key]) => key.startsWith("paseo-chat-find-"))
          .flatMap(([, highlight]) => Array.from(highlight))
          .filter(
            (value): value is Range =>
              value instanceof Range && text.contains(value.startContainer),
          );
        if (selected.length !== 1) return null;
        const range = selected[0]!;
        const prefix = document.createRange();
        prefix.selectNodeContents(text);
        prefix.setEnd(range.startContainer, range.startOffset);
        const actualStart = prefix.toString().length;
        const bounds = range.getBoundingClientRect();
        return actualStart === start &&
          bounds.width > 0 &&
          bounds.height > 0 &&
          bounds.left >= Math.max(...visible.map((rect) => rect.left)) &&
          bounds.right <= Math.min(...visible.map((rect) => rect.right)) &&
          bounds.top >= Math.max(...visible.map((rect) => rect.top)) &&
          bounds.bottom <= Math.min(...visible.map((rect) => rect.bottom))
          ? actualStart
          : null;
      }, expectedStart);
      return observedStart;
    })
    .toBe(expectedStart);
  await expect(row).toHaveAttribute("data-prompt-pinned", "false");
  return observedStart;
}

async function captureActualPromptFrame(page: Page, text: Locator, prefixLength = 0) {
  const snapshot = () =>
    text.evaluate((node, length) => {
      const row = node.closest("[data-actual-prompt-row]")!;
      const outer = row.closest('[data-testid="agent-chat-scroll"]')!;
      const body = row.querySelector('[data-testid="user-message-body-scroll"]')!;
      const clip = node.closest('[data-testid="text-preview-clip"]')!;
      function clientBounds(element: Element) {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left + element.clientLeft,
          top: bounds.top + element.clientTop,
          right: bounds.left + element.clientLeft + element.clientWidth,
          bottom: bounds.top + element.clientTop + element.clientHeight,
        };
      }
      let prefix: { left: number; right: number; top: number; bottom: number } | null = null;
      if (length > 0) {
        const first = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
        if (!first) throw new Error("Expected a mounted prompt text node");
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(first, length);
        const rect = range.getBoundingClientRect();
        prefix = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }
      const bounds = node.getBoundingClientRect();
      const limits = [clip, body, outer].map(clientBounds);
      const left = Math.max(0, bounds.left, ...limits.map((rect) => rect.left));
      const top = Math.max(0, bounds.top, ...limits.map((rect) => rect.top));
      const right = Math.min(innerWidth, bounds.right, ...limits.map((rect) => rect.right));
      const bottom = Math.min(innerHeight, bounds.bottom, ...limits.map((rect) => rect.bottom));
      return {
        capture: { x: left, y: top, width: right - left, height: bottom - top },
        prefix,
        wrapper: row.getBoundingClientRect().toJSON(),
        text: bounds.toJSON(),
        pin: row.getAttribute("data-prompt-pinned"),
        translation: row.getAttribute("data-prompt-translation"),
        outer: {
          top: outer.scrollTop,
          left: outer.scrollLeft,
          bounds: outer.getBoundingClientRect().toJSON(),
        },
        body: {
          top: body.scrollTop,
          left: body.scrollLeft,
          bounds: body.getBoundingClientRect().toJSON(),
        },
        window: { x: scrollX, y: scrollY },
      };
    }, prefixLength);
  const before = await snapshot();
  expect(before.capture.width).toBeGreaterThan(0);
  expect(before.capture.height).toBeGreaterThan(0);
  const pixels = await page.screenshot({ animations: "disabled", clip: before.capture });
  // The screenshot must belong to the measured frame, not one scrolled by capture.
  expect(await snapshot()).toEqual(before);
  return { pixels, capture: before.capture, prefix: before.prefix };
}

export async function captureVisibleActualPrompt(page: Page, text: Locator): Promise<Buffer> {
  return (await captureActualPromptFrame(page, text)).pixels;
}

export async function expectMatchingPromptInk(
  page: Page,
  originalScreenshot: Buffer,
  pinnedText: Locator,
) {
  const pinnedScreenshot = await captureVisibleActualPrompt(page, pinnedText);
  const textColor = await pinnedText.evaluate((node) => {
    for (let parent: Element | null = node; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).opacity !== "1") throw new Error("Pinned foreground is dimmed");
    }
    return getComputedStyle(node).color;
  });
  const ink = await page.evaluate(
    async ({ source, pinned, color }) => {
      const foreground = color.match(/\d+/g)!.slice(0, 3).map(Number);
      async function decodeInk(base64: string) {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, image.width, image.height).data;
        const background = Array.from(pixels.slice(0, 3));
        const foregroundBrightness = foreground.reduce((sum, channel) => sum + channel, 0) / 3;
        const backgroundBrightness = background.reduce((sum, channel) => sum + channel, 0) / 3;
        const threshold =
          foregroundBrightness + (backgroundBrightness - foregroundBrightness) * 0.35;
        const darkText = foregroundBrightness < backgroundBrightness;
        const mask: boolean[] = [];
        for (let index = 0; index < pixels.length; index += 4) {
          const brightness = (pixels[index]! + pixels[index + 1]! + pixels[index + 2]!) / 3;
          mask.push(darkText ? brightness < threshold : brightness > threshold);
        }
        return {
          width: image.width,
          height: image.height,
          mask,
          count: mask.filter(Boolean).length,
        };
      }
      const original = await decodeInk(source);
      const copy = await decodeInk(pinned);
      /** LCD color fringing and grayscale smoothing can choose neighboring edge pixels. */
      function unmatchedPixels(from: typeof original, to: typeof original) {
        return from.mask.filter((painted, index) => {
          if (!painted) return false;
          const x = index % from.width;
          const y = Math.floor(index / from.width);
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              if (
                x + dx >= 0 &&
                x + dx < to.width &&
                y + dy >= 0 &&
                y + dy < to.height &&
                to.mask[(y + dy) * to.width + x + dx]
              )
                return false;
            }
          }
          return true;
        }).length;
      }
      return {
        original: { width: original.width, height: original.height, count: original.count },
        copy: { width: copy.width, height: copy.height, count: copy.count },
        missing: unmatchedPixels(original, copy),
        added: unmatchedPixels(copy, original),
      };
    },
    {
      source: originalScreenshot.toString("base64"),
      pinned: pinnedScreenshot.toString("base64"),
      color: textColor,
    },
  );
  expect(ink.original.count).toBeGreaterThan(0);
  expect(ink.copy.width).toBe(ink.original.width);
  expect(ink.copy.height).toBe(ink.original.height);
  expect(ink.missing).toBe(0);
  expect(ink.added).toBe(0);
  expect(ink.copy.count / ink.original.count).toBeGreaterThan(0.9);
  expect(ink.copy.count / ink.original.count).toBeLessThan(1.1);
}

export async function expectActualTextIdentity(
  row: Locator,
  original: import("@playwright/test").ElementHandle<HTMLElement | SVGElement>,
  prompt: string,
) {
  expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  expect(
    await row.getByTestId("user-message-text").evaluate((node, prior) => node === prior, original),
  ).toBe(true);
  await expect(row.getByTestId("text-preview-measurement")).toHaveCount(0);
  await expect(row.getByTestId("user-message-prefix-mask")).toHaveCount(0);
  expect(
    await row.evaluate((node, content) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let count = 0;
      while (walker.nextNode()) if (walker.currentNode.textContent === content) count++;
      return count;
    }, prompt),
  ).toBe(1);
}
