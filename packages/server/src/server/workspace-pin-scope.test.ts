import { describe, expect, it } from "vitest";
import { forkCapabilities } from "./fork-capabilities.js";
import { resolveWorkspacePinFields } from "./workspace-pin-scope.js";

describe("workspace pin scope", () => {
  it("advertises project workspace pinning once the module loads", () => {
    expect(forkCapabilities()).toMatchObject({ projectWorkspacePinning: true });
  });

  it("pins globally and clears any project pin", () => {
    expect(resolveWorkspacePinFields("global", "2026-11-07T12:00:00.000Z")).toEqual({
      pinnedAt: "2026-11-07T12:00:00.000Z",
      projectPinnedAt: null,
    });
  });

  it("pins in the project and clears any global pin", () => {
    expect(resolveWorkspacePinFields("project", "2026-11-07T12:00:00.000Z")).toEqual({
      pinnedAt: null,
      projectPinnedAt: "2026-11-07T12:00:00.000Z",
    });
  });

  it("unpins both scopes", () => {
    expect(resolveWorkspacePinFields("project", null)).toEqual({
      pinnedAt: null,
      projectPinnedAt: null,
    });
  });
});
