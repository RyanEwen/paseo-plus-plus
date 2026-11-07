import { describe, expect, it } from "vitest";
import { limitSidebarWorkspaces } from "./workspace-limit";

describe("limitSidebarWorkspaces keeps the open workspace", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    id: `row-${index}`,
    statusEnteredAt: new Date(Date.parse("2026-10-16T12:00:00Z") - index * 86_400_000),
  }));
  const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);
  const isOpen = (id: string) => (item: { id: string }) => item.id === id;

  it("adds an open workspace beyond the count window in its saved position", () => {
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: 7,
      expanded: false,
      keep: isOpen("row-9"),
    });
    expect(ids(result.visibleItems)).toEqual([...ids(rows.slice(0, 7)), "row-9"]);
    expect(result.canToggle).toBe(true);
  });

  it("adds an open workspace older than the age window", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: null,
      expanded: false,
      updatedWithin: { days: 2, now, getStatusEnteredAt: (row) => row.statusEnteredAt },
      keep: isOpen("row-5"),
    });
    expect(ids(result.visibleItems)).toEqual(["row-0", "row-1", "row-2", "row-5"]);
  });

  it("adds nothing when the open workspace is already inside the window", () => {
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: 7,
      expanded: false,
      keep: isOpen("row-3"),
    });
    expect(ids(result.visibleItems)).toEqual(ids(rows.slice(0, 7)));
  });

  it("shows every row once when expanded", () => {
    const result = limitSidebarWorkspaces({
      items: rows,
      initialCount: 7,
      expanded: true,
      keep: isOpen("row-9"),
    });
    expect(ids(result.visibleItems)).toEqual(ids(rows));
  });
});
