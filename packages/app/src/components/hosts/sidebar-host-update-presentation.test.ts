import { describe, expect, test } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import type { HostProfile } from "@/types/host-connection";
import {
  CLOSED_HOST_UPDATE,
  isHostUpdateSheetVisible,
  reduceHostUpdatePresentation,
  type HostUpdatePresentation,
} from "./sidebar-host-update-presentation";

function hostProfile(serverId: string): HostProfile {
  return {
    serverId,
    label: serverId,
    connections: [],
    appearance: defaultHostAppearance(),
    lifecycle: {},
    preferredConnectionId: null,
    createdAt: "2026-10-14T00:00:00Z",
    updatedAt: "2026-10-14T00:00:00Z",
  };
}

const hostA = hostProfile("host-a");
const hostB = hostProfile("host-b");
const running: HostUpdatePresentation = { host: hostA, busy: true, dismissed: false };

describe("reduceHostUpdatePresentation", () => {
  test("starting presents the host as busy", () => {
    expect(
      reduceHostUpdatePresentation(CLOSED_HOST_UPDATE, { type: "start", host: hostA }),
    ).toEqual(running);
  });

  test("a second start while busy keeps the running attempt", () => {
    expect(reduceHostUpdatePresentation(running, { type: "start", host: hostB })).toBe(running);
  });

  test("a new attempt after a dismissed one is shown again", () => {
    const settledAndDismissed = { host: hostA, busy: false, dismissed: true };
    expect(
      reduceHostUpdatePresentation(settledAndDismissed, { type: "start", host: hostB }),
    ).toEqual({ host: hostB, busy: true, dismissed: false });
  });

  test("a settled attempt stays presented until closed", () => {
    expect(reduceHostUpdatePresentation(running, { type: "finished", outcome: "settled" })).toEqual(
      { host: hostA, busy: false, dismissed: false },
    );
  });

  test.each(["cancelled", "duplicate"] as const)("a %s attempt closes the sheet", (outcome) => {
    expect(reduceHostUpdatePresentation(running, { type: "finished", outcome })).toEqual(
      CLOSED_HOST_UPDATE,
    );
  });

  test("dismissing hides progress while the attempt keeps running", () => {
    expect(reduceHostUpdatePresentation(running, { type: "dismiss" })).toEqual({
      host: hostA,
      busy: true,
      dismissed: true,
    });
  });

  test("closing removes the sheet", () => {
    const settled = { host: hostA, busy: false, dismissed: false };
    expect(reduceHostUpdatePresentation(settled, { type: "close" })).toEqual({
      host: null,
      busy: false,
      dismissed: false,
    });
  });
});

describe("isHostUpdateSheetVisible", () => {
  test("a presented attempt with progress is visible", () => {
    expect(isHostUpdateSheetVisible(running, "updating")).toBe(true);
  });

  test("nothing shows while the confirmation is open", () => {
    expect(isHostUpdateSheetVisible(running, "idle")).toBe(false);
  });

  test("dismissed progress stays hidden", () => {
    expect(isHostUpdateSheetVisible({ ...running, dismissed: true }, "updating")).toBe(false);
  });

  test("a failure after dismissed progress is shown again", () => {
    const dismissed = reduceHostUpdatePresentation(running, { type: "dismiss" });
    const failed = reduceHostUpdatePresentation(dismissed, {
      type: "finished",
      outcome: "settled",
    });

    expect(isHostUpdateSheetVisible(failed, "failed")).toBe(true);
  });

  test("a success after dismissed progress stays hidden", () => {
    const dismissed = reduceHostUpdatePresentation(running, { type: "dismiss" });
    const succeeded = reduceHostUpdatePresentation(dismissed, {
      type: "finished",
      outcome: "settled",
    });

    expect(isHostUpdateSheetVisible(succeeded, "complete")).toBe(false);
  });

  test("a closed sheet is hidden", () => {
    expect(isHostUpdateSheetVisible(CLOSED_HOST_UPDATE, "complete")).toBe(false);
  });
});
