import {
  selectChatPreferencesSupport,
  exportSupportedChatPreferences,
} from "./chat-preferences-support";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { expect, it } from "vitest";

it("chat display uses only the selected settings host capability, preserving device-only choices", () => {
  const capable = ServerInfoStatusPayloadSchema.parse({
    status: "server_info",
    serverId: "capable",
    features: { appSettingsSync: true, appSettingsChatPreferences: true },
  });
  const old = ServerInfoStatusPayloadSchema.parse({
    status: "server_info",
    serverId: "old",
    features: { appSettingsSync: true },
  });
  const state = { sessions: { capable: { serverInfo: capable }, old: { serverInfo: old } } };
  expect(selectChatPreferencesSupport(state, null)).toBe(true);
  expect(selectChatPreferencesSupport(state, "capable")).toBe(true);
  expect(selectChatPreferencesSupport(state, "old")).toBe(false);
  expect(selectChatPreferencesSupport(state, "missing")).toBe(false);
});

it("publishes chat preferences only to a capable settings host while backups and local choices preserve them", () => {
  const app = {
    theme: "dark",
    chatDisplay: "collapseToolCalls",
    sendShortcut: "mod-enter",
    future: { preserved: true },
  };
  expect(exportSupportedChatPreferences(app, false, "publish")).toEqual({
    theme: "dark",
    future: { preserved: true },
  });
  expect(exportSupportedChatPreferences(app, false, "backup")).toEqual(app);
  expect(exportSupportedChatPreferences(app, true, "publish")).toEqual(app);
  expect(
    exportSupportedChatPreferences(
      app,
      selectChatPreferencesSupport({ sessions: {} }, null),
      "publish",
    ),
  ).toEqual(app);
  expect(app.sendShortcut).toBe("mod-enter");
  expect(app.chatDisplay).toBe("collapseToolCalls");
});
