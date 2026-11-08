import { describe, expect, it } from "vitest";
import { statusGroupHeaderDataSet, statusGroupHeaderSelector } from "./status-group-header-anchor";

describe("status group header anchor", () => {
  it("selects the attribute React Native Web renders from the data set", () => {
    const [[name, value]] = Object.entries(statusGroupHeaderDataSet("needs_input"));
    const attribute = `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    expect(statusGroupHeaderSelector("needs_input", (key) => key)).toBe(
      `[${attribute}="${value}"]`,
    );
  });

  it("escapes the group key", () => {
    expect(statusGroupHeaderSelector('a"b', (key) => key.replace('"', '\\"'))).toBe(
      '[data-sidebar-status-group-key="a\\"b"]',
    );
  });
});
