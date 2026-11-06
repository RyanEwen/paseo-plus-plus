/**
 * Device-local settings registry shared by every fork layer.
 *
 * These keys stay on the device that set them, even when a settings host is selected. Each
 * feature owns its own line; consumers skip keys absent from the running build.
 */

/** Physical display, installed fonts, input hardware and local window capabilities differ by device. */
export const DEVICE_LOCAL_APP_SETTING_KEYS = [
  "uiFontFamily",
  "monoFontFamily",
  "uiBaseFontSize",
  "contentFontSize",
  "codeFontSize",
  "contentMaxWidth",
  "terminalScrollbackLines",
  "useLegacyTerminalRenderer",
  "serviceUrlBehavior",
  "vimKeybindings",
  "openInSidePane",
  "pullRequestOpenLocation",
  "autoOpenExplorerSidebar",
] as const;

export const DEVICE_LOCAL_FORK_SETTING_KEYS = [
  "mobileWorkspaceTabs",
  "widerWorkspaceTabs",
  "explorerIconOnlyTabs",
  "splitLayoutPresets",
  "androidAutomaticUpdateChecks",
] as const;
