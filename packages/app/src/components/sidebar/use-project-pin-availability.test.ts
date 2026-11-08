import { describe, expect, it } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import { isProjectPinBlockedByHost } from "./use-project-pin-availability";

function serverInfo(features: DaemonServerInfo["features"]): DaemonServerInfo {
  return { features } as DaemonServerInfo;
}

describe("project pin host availability", () => {
  it("blocks a host that reports no project pin capability", () => {
    expect(isProjectPinBlockedByHost(serverInfo({}))).toBe(true);
  });

  it("allows a host that reports the capability", () => {
    expect(isProjectPinBlockedByHost(serverInfo({ projectWorkspacePinning: true }))).toBe(false);
  });

  it("does not ask to update a host whose server info is unknown", () => {
    expect(isProjectPinBlockedByHost(null)).toBe(false);
    expect(isProjectPinBlockedByHost(undefined)).toBe(false);
  });
});
