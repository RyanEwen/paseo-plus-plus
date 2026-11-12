/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { hasPendingMarkdownRows, isWebHistoryUnderfilled } from "./web-history-start-geometry";

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

  it("reports a row that is still parsing, so the fill decision waits for real heights", () => {
    // A cold open measured 48px of rows while a long answer was still parsing; deciding then
    // fetched a page the full chat did not need.
    const rowsHost = sizedElement(48);
    rowsHost.append(pendingMarkdownRow());
    expect(hasPendingMarkdownRows(rowsHost)).toBe(true);
  });

  it("ignores a streaming message re-parsing text it already shows", () => {
    const rowsHost = sizedElement(300);
    const row = pendingMarkdownRow();
    row.firstElementChild!.textContent = "Text already on screen";
    rowsHost.append(row);
    expect(hasPendingMarkdownRows(rowsHost)).toBe(false);
  });

  it("reports no pending parse once every row has rendered", () => {
    const rowsHost = sizedElement(48);
    rowsHost.append(document.createElement("div"));
    expect(hasPendingMarkdownRows(rowsHost)).toBe(false);
    expect(hasPendingMarkdownRows(null)).toBe(false);
    // A genuinely short chat is still underfilled, so upstream's initial fill runs.
    expect(
      isWebHistoryUnderfilled({ rowsHost, auxiliary: sizedElement(106), viewportHeight: 696 }),
    ).toBe(true);
  });
});
