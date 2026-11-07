/**
 * The Workspace limits pages of the Display menu: their ids and title keys. The menu attaches
 * each page's content, so this list can stay a plain, testable description.
 */
export interface WorkspaceLimitPageSpec {
  id: "workspaceList" | "workspaceCount" | "workspaceUpdatedWithin";
  titleKey: string;
  /** False for a page that takes text input; see docs/menus.md "A page that takes input". */
  hoverIntent?: false;
}

export const WORKSPACE_LIMIT_PAGES: readonly WorkspaceLimitPageSpec[] = [
  { id: "workspaceList", titleKey: "paseoPlusPlus.workspaceLimit.title" },
  {
    id: "workspaceCount",
    titleKey: "sidebar.display.workspaceList.countLimit",
    hoverIntent: false,
  },
  { id: "workspaceUpdatedWithin", titleKey: "sidebar.display.workspaceList.updatedWithin" },
];
