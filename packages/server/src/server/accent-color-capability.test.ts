import { describe, expect, it } from "vitest";
import { forkCapabilities } from "./fork-capabilities.js";
import "./accent-color-capability.js";

describe("accent color capability", () => {
  it("is advertised once the accent layer's server module loads", () => {
    expect(forkCapabilities()).toMatchObject({ appSettingsAccentColor: true });
  });
});
