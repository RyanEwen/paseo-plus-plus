import { describe, expect, it } from "vitest";
import { listSettingsSectionRows, registerSettingsSectionRow } from "./section-extension-rows";

const Row = () => null;

describe("settings section extension rows", () => {
  it("lists rows per section in registration order", () => {
    const first = registerSettingsSectionRow("test-order", { id: "first", Row });
    const second = registerSettingsSectionRow("test-order", { id: "second", Row });
    const other = registerSettingsSectionRow("test-other", { id: "first", Row });
    try {
      expect(listSettingsSectionRows("test-order").map((row) => row.id)).toEqual([
        "first",
        "second",
      ]);
      expect(listSettingsSectionRows("test-other").map((row) => row.id)).toEqual(["first"]);
    } finally {
      first();
      second();
      other();
    }
  });

  it("removes a row when unregistered and leaves unknown sections empty", () => {
    const unregister = registerSettingsSectionRow("test-remove", { id: "row", Row });
    unregister();
    expect(listSettingsSectionRows("test-remove")).toEqual([]);
    expect(listSettingsSectionRows("test-unknown")).toEqual([]);
  });

  it("rejects a duplicate row id within one section", () => {
    const unregister = registerSettingsSectionRow("test-duplicate", { id: "row", Row });
    try {
      expect(() => registerSettingsSectionRow("test-duplicate", { id: "row", Row })).toThrow(
        "already has a row row",
      );
    } finally {
      unregister();
    }
  });
});
