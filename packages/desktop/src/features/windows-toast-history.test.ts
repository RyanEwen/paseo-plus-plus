import { describe, expect, it } from "vitest";
import { createPackagedWindowsToastHistory } from "./windows-toast-history.js";

const packagedWindows = {
  platform: "win32" as const,
  isPackaged: true,
  appUserModelId: "sh.paseo.plusplus.desktop",
  executable: "C:\\Program Files\\Paseo++\\Paseo++.exe",
};

describe("packaged Windows toast history", () => {
  it("is available on a packaged Windows build with an explicit app user model ID", () => {
    const history = createPackagedWindowsToastHistory(packagedWindows);

    expect(history).not.toBeNull();
  });

  it.each([
    ["an unpackaged Windows build", { isPackaged: false }],
    ["a build without an explicit app user model ID", { appUserModelId: null }],
    ["a non-Windows build", { platform: "darwin" as const }],
  ])("is absent on %s", (_label, override) => {
    expect(createPackagedWindowsToastHistory({ ...packagedWindows, ...override })).toBeNull();
  });
});
