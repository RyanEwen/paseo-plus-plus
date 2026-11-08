import { queryClient } from "@/data/query-client";
import { readLoadedAppSettings } from "@/hooks/use-settings/snapshot";
import { setPaneHiddenInLayout, type WorkspaceLayout } from "@/stores/workspace-layout-actions";

interface NewLayoutsInput {
  next: Record<string, WorkspaceLayout>;
  previous: Record<string, WorkspaceLayout>;
  /** False while persisted layouts load; those are saved choices, not new layouts. */
  hydrated: boolean;
}

interface ResolvePendingInput {
  workspaceKey: string;
  layout: WorkspaceLayout;
  explorerPaneId: string | null;
}

/**
 * Remembers layouts created before app settings loaded, such as by a notification or deep link
 * on a cold start, so automatic Explorer opening still applies to them. The record lives for
 * the session: if the app closes first, that layout keeps its closed Explorer.
 */
export function createPendingExplorerDefaults() {
  const pending = new Set<string>();

  /** Record workspaces whose layout first appeared while settings were still unknown. */
  function recordNewLayouts({ next, previous, hydrated }: NewLayoutsInput): void {
    if (next === previous || !hydrated || readLoadedAppSettings(queryClient)) {
      return;
    }
    for (const workspaceKey of Object.keys(next)) {
      if (!(workspaceKey in previous)) {
        pending.add(workspaceKey);
      }
    }
  }

  /**
   * Apply the Explorer default once settings are known. Returns `layout` itself when nothing
   * changes. A pending workspace waits while settings remain unavailable.
   */
  function resolve({ workspaceKey, layout, explorerPaneId }: ResolvePendingInput): WorkspaceLayout {
    if (!pending.has(workspaceKey)) {
      return layout;
    }
    const settings = readLoadedAppSettings(queryClient);
    if (!settings) {
      return layout;
    }
    pending.delete(workspaceKey);
    if (!settings.autoOpenExplorerSidebar || !explorerPaneId) {
      return layout;
    }
    return setPaneHiddenInLayout({ layout, paneId: explorerPaneId, hidden: false }) ?? layout;
  }

  return { recordNewLayouts, resolve };
}
