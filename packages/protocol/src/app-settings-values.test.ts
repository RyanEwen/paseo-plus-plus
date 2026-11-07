import { describe, expect, it } from "vitest";
import { applySettingsPatches } from "./app-settings-values.js";

describe("applySettingsPatches", () => {
  it("creates missing intermediate objects and keeps unknown siblings", () => {
    const values = { app: { theme: "dark", future: true } };
    const next = applySettingsPatches(values, [
      { path: ["app", "usage", "displayAs"], value: "remaining", expectedRevision: 0 },
    ]);
    expect(next).toEqual({
      app: { theme: "dark", future: true, usage: { displayAs: "remaining" } },
    });
    expect(values).toEqual({ app: { theme: "dark", future: true } });
  });

  it("refuses to replace a stored non-object value with an intermediate object", () => {
    const values = { app: { usage: "legacy" } };
    expect(() =>
      applySettingsPatches(values, [
        { path: ["app", "usage", "displayAs"], value: "remaining", expectedRevision: 0 },
      ]),
    ).toThrow("Preference path is not an object");
  });
});
