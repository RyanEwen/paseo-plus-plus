import { describe, expect, it } from "vitest";

import {
  ACTIVITY_READ_COMMAND,
  buildToolActivityScene,
  requestsToolActivityScene,
} from "./mock-tool-activity-scene.js";

describe("mock readable tool activity scene", () => {
  it("is requested by its prompt only", () => {
    expect(requestsToolActivityScene("Emit the readable tool activity scene.")).toBe(true);
    expect(requestsToolActivityScene("Show readable provider operations.")).toBe(false);
  });

  it("carries the provider metadata readable activity depends on", () => {
    const scene = buildToolActivityScene("/work");
    expect(scene.map((call) => [call.callId, call.status])).toEqual([
      ["read", "completed"],
      ["failed-edit", "failed"],
      ["canceled-write", "canceled"],
      ["search", "completed"],
      ["multi-patch", "completed"],
      ["running-script", "running"],
      ["opaque-failed", "failed"],
    ]);
    expect(scene[0]?.metadata).toEqual({
      commandActions: [
        {
          type: "read",
          command: ACTIVITY_READ_COMMAND,
          name: "notifications.ts",
          path: "/work/src/notifications.ts",
        },
      ],
    });
    expect(scene[4]?.metadata).toMatchObject({
      fileChanges: [
        { kind: "add", diff: "+created-file-exact-diff" },
        { kind: "update", diff: "-before\n+updated-file-exact-diff" },
        { kind: "delete", diff: "-deleted-file-exact-diff" },
      ],
    });
  });
});
