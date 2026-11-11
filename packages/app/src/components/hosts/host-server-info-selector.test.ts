import { expect, test } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import { createHostServerInfoSelector } from "./host-server-info-selector";

const infoA: DaemonServerInfo = { serverId: "host-a", hostname: null, version: "1.0.0" };

test("keys server info by host and reports hosts without a session as null", () => {
  const select = createHostServerInfoSelector(["host-a", "host-b"]);

  expect(select({ sessions: { "host-a": { serverInfo: infoA } } })).toEqual({
    "host-a": infoA,
    "host-b": null,
  });
});

test("returns the same object while the sessions map is unchanged", () => {
  const select = createHostServerInfoSelector(["host-a"]);
  const sessions = { "host-a": { serverInfo: infoA } };

  const first = select({ sessions });

  expect(select({ sessions })).toBe(first);
  expect(select({ sessions: { ...sessions } })).not.toBe(first);
});
