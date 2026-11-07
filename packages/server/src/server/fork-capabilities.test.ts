import { describe, expect, it } from "vitest";
import { forkCapabilities, registerForkCapability } from "./fork-capabilities.js";

describe("fork capability registry", () => {
  it("advertises only registered flags, each once", () => {
    expect(forkCapabilities()).not.toHaveProperty("checkoutFileDiff");
    registerForkCapability("checkoutFileDiff");
    registerForkCapability("checkoutFileDiff");
    expect(forkCapabilities()).toMatchObject({ checkoutFileDiff: true });
    expect(Object.keys(forkCapabilities()).filter((name) => name === "checkoutFileDiff")).toEqual([
      "checkoutFileDiff",
    ]);
  });
});
