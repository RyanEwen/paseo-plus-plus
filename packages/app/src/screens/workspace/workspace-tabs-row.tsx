// COMPAT(workspaceTabRowRename): added in v0.13.0, remove after 2027-04-21 once fork callers migrate.
// Retained fork Explorer callers still import the pre-rename module.
export {
  WorkspaceDesktopTabsRow as WorkspaceTabsRow,
  type WorkspaceDesktopTabRowItem as WorkspaceTabRowItem,
  type WorkspaceDesktopTabsRowProps as WorkspaceTabsRowProps,
} from "./workspace-desktop-tabs-row";
