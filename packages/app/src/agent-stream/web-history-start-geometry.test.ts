/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { isWebHistoryUnderfilled } from "./web-history-start-geometry";

/** An element whose layout box reports `height`, since jsdom does no layout. */
function sizedElement(height: number): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => ({ height }) as DOMRect;
  return element;
}

/** A transcript row whose Markdown is still parsing, as the web renderer marks it. */
function pendingMarkdownRow(): HTMLElement {
  const row = document.createElement("div");
  const markdown = document.createElement("div");
  markdown.setAttribute("aria-busy", "true");
  row.append(markdown);
  return row;
}

describe("isWebHistoryUnderfilled", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("is underfilled when rows and auxiliary content are shorter than the viewport", () => {
    expect(
      isWebHistoryUnderfilled({
        rowsHost: sizedElement(300),
        auxiliary: sizedElement(100),
        viewportHeight: 516,
      }),
    ).toBe(true);
  });

  it("is full when the content reaches the viewport", () => {
    expect(
      isWebHistoryUnderfilled({
        rowsHost: sizedElement(416),
        auxiliary: sizedElement(100),
        viewportHeight: 516,
      }),
    ).toBe(false);
  });

  it("waits for a pending Markdown parse instead of reading its empty row as short", () => {
    // A cold open measured 48px of rows while a long answer was still parsing.
    const rowsHost = sizedElement(48);
    rowsHost.append(pendingMarkdownRow());
    expect(
      isWebHistoryUnderfilled({ rowsHost, auxiliary: sizedElement(106), viewportHeight: 696 }),
    ).toBe(false);
  });
});
