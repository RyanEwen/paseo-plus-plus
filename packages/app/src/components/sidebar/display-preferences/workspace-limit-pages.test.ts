import { describe, expect, it } from "vitest";
import { WORKSPACE_LIMIT_PAGES } from "./workspace-limit-pages";

describe("workspace limit menu pages", () => {
  it("keeps the count editor off pointer hover so typing is never dismissed", () => {
    const count = WORKSPACE_LIMIT_PAGES.find((page) => page.id === "workspaceCount");
    expect(count?.hoverIntent).toBe(false);
  });

  it("lets pick-one pages open on hover like their siblings", () => {
    for (const page of WORKSPACE_LIMIT_PAGES) {
      if (page.id === "workspaceCount") continue;
      expect(page.hoverIntent).toBeUndefined();
    }
  });
});
