import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { exportSupportedAccentSettings, selectAccentColorSupport } from "./accent-support";

const olderHost = ServerInfoStatusPayloadSchema.parse({
  status: "server_info",
  serverId: "older",
  features: { appSettingsSync: true },
});
const accentHost = ServerInfoStatusPayloadSchema.parse({
  status: "server_info",
  serverId: "accent",
  features: { appSettingsSync: true, appSettingsAccentColor: true },
});
const sessions = { older: { serverInfo: olderHost }, accent: { serverInfo: accentHost } };

describe("selectAccentColorSupport", () => {
  it("allows the accent on this device and on a host with the capability", () => {
    expect(selectAccentColorSupport({ sessions }, null)).toBe(true);
    expect(selectAccentColorSupport({ sessions }, "accent")).toBe(true);
  });

  it("blocks an older or unknown selected host", () => {
    expect(selectAccentColorSupport({ sessions }, "older")).toBe(false);
    expect(selectAccentColorSupport({ sessions }, "missing")).toBe(false);
  });
});

describe("exportSupportedAccentSettings", () => {
  const app = { theme: "dark", accentColor: "purple", future: { preserved: true } };

  it("keeps the accent for a host that can store it", () => {
    expect(exportSupportedAccentSettings({ app, supported: true })).toEqual(app);
  });

  it("omits only the accent for a host that cannot, leaving the input unchanged", () => {
    expect(exportSupportedAccentSettings({ app, supported: false })).toEqual({
      theme: "dark",
      future: { preserved: true },
    });
    expect(app.accentColor).toBe("purple");
  });
});
