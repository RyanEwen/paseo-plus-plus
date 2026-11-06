/**
 * Synced settings key registry shared by every fork layer.
 *
 * Plain string lists with no logic. Each feature owns its own line, so a layer that lacks a
 * feature still lists that feature's key; consumers skip keys absent from the running build.
 */

/** Preference domains accepted for writes. Unrecognized stored fields remain readable and intact. */
export const SYNC_APP_SETTING_KEYS = [
  "paseoPlusPlus",
  "theme",
  "pluginThemeId",
  "accentColor",
  "language",
  "sendBehavior",
  "sendShortcut",
  "serviceUrlBehavior",
  "terminalScrollbackLines",
  "useLegacyTerminalRenderer",
  "uiFontFamily",
  "monoFontFamily",
  "uiBaseFontSize",
  "contentFontSize",
  "codeFontSize",
  "contentMaxWidth",
  "syntaxTheme",
  "workspaceTitleSource",
  "sidebarInitialWorkspaceCount",
  "sidebarWorkspaceTrailing",
  "sidebarRowItems",
  "sidebarChecksDisplay",
  "sidebarNavItems",
  "sidebarFooterItems",
  "usage",
  "autoExpandReasoning",
  "toolCallDetailLevel",
  "chatDisplay",
  "chatOutlineEnabled",
  "vimKeybindings",
  "openInSidePane",
  "pullRequestOpenLocation",
  "autoOpenExplorerSidebar",
  "explorerDiffScope",
  "workingDiffDefaultComparison",
  "workingDiffAutoSwitch",
] as const;
export const SYNC_SIDEBAR_SETTING_KEYS = [
  "modeProfiles",
  "groupMode",
  "sortMode",
  "workspaceSortMode",
  "projectVisibility",
  "groupEmptyProjects",
  "emptyProjectSortMode",
  "showBackground",
  "labelFilter",
] as const;

/** Writable sync domains, keyed by the first segment of a settings patch path. */
export const SYNC_SETTING_DOMAINS = {
  app: SYNC_APP_SETTING_KEYS,
  sidebar: SYNC_SIDEBAR_SETTING_KEYS,
} as const satisfies Record<string, readonly string[]>;
