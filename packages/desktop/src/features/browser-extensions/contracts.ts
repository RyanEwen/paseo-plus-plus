import type { ExtensionActionBadge } from "./action-badges.js";
import type { BrowserExtensionEntry } from "./catalog.js";

/**
 * Settings IPC contracts for the browser extension bridge. The app declares the same
 * shapes as `DesktopBrowserExtension` and `DesktopBrowserExtensionAction` in
 * `packages/app/src/desktop/host.ts`; keep the two in step.
 */

/** One saved extension as listed in Settings, with any recoverable load or runtime error. */
export interface BrowserExtensionListing extends BrowserExtensionEntry {
  error?: string;
}

/** One loaded extension's toolbar action for a specific browser tab. */
export interface BrowserExtensionAction {
  id: string;
  name: string;
  title: string;
  iconDataUrl: string | null;
  badge: ExtensionActionBadge;
  pinned: boolean;
  hasPopup: boolean;
}
