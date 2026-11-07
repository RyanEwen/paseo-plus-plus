import type { Session } from "electron";
import { describeVisibleExtensionTab, describeVisibleExtensionTabChanges } from "./tab-access.js";
import type { BrowserExtensionTab } from "./tab-projection.js";
import type { BrowserExtensionTabChanges } from "./tab-observation.js";

/** Deliver one extension API event to one extension by ID. */
export type ExtensionEventSink = (id: string, name: string, ...args: unknown[]) => void;

/** Send the same event to every extension loaded in the browser profile. */
export function emitToExtensions(
  profile: Session,
  emit: ExtensionEventSink,
  name: string,
  ...args: unknown[]
): void {
  for (const extension of profile.extensions.getAllExtensions()) {
    emit(extension.id, name, ...args);
  }
}

/** Report a new tab, describing it through each extension's own metadata grants. */
export function emitTabCreatedToExtensions(
  profile: Session,
  emit: ExtensionEventSink,
  tab: BrowserExtensionTab,
): void {
  for (const extension of profile.extensions.getAllExtensions()) {
    emit(extension.id, "tabs.onCreated", describeVisibleExtensionTab(extension, tab));
  }
}

/** Report tab changes only to extensions allowed to see at least one changed field. */
export function emitTabUpdatedToExtensions(
  profile: Session,
  emit: ExtensionEventSink,
  changes: BrowserExtensionTabChanges,
  tab: BrowserExtensionTab,
): void {
  for (const extension of profile.extensions.getAllExtensions()) {
    const visibleChanges = describeVisibleExtensionTabChanges(extension, changes, tab);
    if (Object.keys(visibleChanges).length === 0) {
      continue;
    }
    emit(
      extension.id,
      "tabs.onUpdated",
      tab.id,
      visibleChanges,
      describeVisibleExtensionTab(extension, tab),
    );
  }
}
