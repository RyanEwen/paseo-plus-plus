import { describe, expect, it } from "vitest";
import { createWindowsToastHistory } from "./windows-toast-history.js";

// The Windows QA lane supplies the already installed, owned executable in PASEO_QA_EXECUTABLE.
// This case reads history only; it never installs, registers, sends or removes.
describe("normally installed Windows notification history", () => {
  it("reads current and legacy history through the owned installer shortcut", async () => {
    const executable = process.env.PASEO_QA_EXECUTABLE;
    if (!executable) throw new Error("PASEO_QA_EXECUTABLE must name the installed QA executable");
    const history = createWindowsToastHistory({ executable });

    const entries = await history.list();

    for (const entry of entries) {
      expect(["current", "legacy"]).toContain(entry.namespace);
      expect(entry.tag).not.toBe("");
      expect(entry.group).not.toBe("");
      expect(typeof entry.arguments).toBe("string");
    }
  });
});
