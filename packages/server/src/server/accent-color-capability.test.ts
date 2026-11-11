import { describe, expect, it } from "vitest";
import { forkCapabilities } from "./fork-capabilities.js";
import { registerAccentColorCapability } from "./accent-color-capability.js";

describe("accent color capability", () => {
  it("is advertised once the accent layer registers it", () => {
    registerAccentColorCapability();
    expect(forkCapabilities()).toMatchObject({ appSettingsAccentColor: true });
  });
});
