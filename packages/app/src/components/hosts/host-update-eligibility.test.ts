import { describe, expect, test } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import {
  isHostUpdateOffered,
  resolveHostUpdateSupport,
  shouldCheckHostUpdate,
  type HostUpdateRowState,
} from "./host-update-eligibility";

function serverInfo(features: DaemonServerInfo["features"]): DaemonServerInfo {
  return { serverId: "host-a", hostname: null, version: "0.11.1-preview.12", features };
}

const openRow: HostUpdateRowState = {
  support: "checked",
  enabled: true,
  connected: true,
  hasClient: true,
};
const confirmedRelease = { settled: true, version: "0.11.1-preview.13" };

describe("resolveHostUpdateSupport", () => {
  test("a host that answers availability checks is checked", () => {
    expect(resolveHostUpdateSupport(serverInfo({ daemonUpdateAvailability: true }))).toBe(
      "checked",
    );
  });

  test("a host without the availability flag gets the manual update", () => {
    expect(resolveHostUpdateSupport(serverInfo({}))).toBe("manual");
  });

  test("a host that reports no availability check is offered nothing", () => {
    expect(resolveHostUpdateSupport(serverInfo({ daemonUpdateAvailability: false }))).toBe("none");
  });

  test.each([null, undefined])("a host with no server info yet (%s) is offered nothing", (info) => {
    expect(resolveHostUpdateSupport(info)).toBe("none");
  });
});

describe("shouldCheckHostUpdate", () => {
  test("an open, connected, checked host is asked for a release", () => {
    expect(shouldCheckHostUpdate(openRow)).toBe(true);
  });

  test.each<[string, Partial<HostUpdateRowState>]>([
    ["the menu is closed", { enabled: false }],
    ["the host is disconnected", { connected: false }],
    ["the host has no client", { hasClient: false }],
    ["the host uses the manual update", { support: "manual" }],
    ["the host has no support", { support: "none" }],
  ])("no check runs when %s", (_case, change) => {
    expect(shouldCheckHostUpdate({ ...openRow, ...change })).toBe(false);
  });
});

describe("isHostUpdateOffered", () => {
  test("a confirmed newer release is offered", () => {
    expect(isHostUpdateOffered(openRow, confirmedRelease)).toBe(true);
  });

  test.each<[string, Partial<HostUpdateRowState>, { settled: boolean; version: string | null }]>([
    ["the check found no newer release", {}, { settled: true, version: null }],
    ["the check is still running or failed", {}, { settled: false, version: "0.11.1-preview.13" }],
    ["the menu is closed", { enabled: false }, confirmedRelease],
    ["the host is disconnected", { connected: false }, confirmedRelease],
    ["the host has no client", { hasClient: false }, confirmedRelease],
    ["the host has no support", { support: "none" }, confirmedRelease],
  ])("nothing is offered when %s", (_case, change, check) => {
    expect(isHostUpdateOffered({ ...openRow, ...change }, check)).toBe(false);
  });

  test("a connected manual host is offered without a check", () => {
    expect(
      isHostUpdateOffered({ ...openRow, support: "manual" }, { settled: false, version: null }),
    ).toBe(true);
  });

  test("a disconnected manual host is offered nothing", () => {
    expect(
      isHostUpdateOffered(
        { ...openRow, support: "manual", connected: false },
        { settled: false, version: null },
      ),
    ).toBe(false);
  });
});
