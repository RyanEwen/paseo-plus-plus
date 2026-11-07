import { resolveSidebarCollapseTargets } from "./bulk-collapse-targets";
import { useSidebarModel } from "./sidebar-model";
import { useAppSettings } from "@/hooks/use-settings";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";

/**
 * Expand all and Collapse all for the desktop header buttons and the compact Display menu.
 * `enabled` is the Expand and collapse all preference, so both surfaces share one gate. Each
 * action resolves the sections the current filters render and applies them in one persisted
 * store transition.
 */
export function useSidebarBulkCollapse() {
  const { settings } = useAppSettings();
  const { projects, workspaceGroups, pinnedGroups, groupMode, workspaceTree } = useSidebarModel();
  const groupEmptyProjects = useSidebarViewStore((state) => state.groupEmptyProjects);
  const setSectionsCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.setSectionsCollapsed,
  );

  function setAllCollapsed(collapsed: boolean) {
    const targets = resolveSidebarCollapseTargets({
      projects,
      workspaceGroups,
      pinnedGroups,
      groupMode,
      workspaceTree,
      groupEmptyProjects,
    });
    setSectionsCollapsed(targets, collapsed);
  }

  return {
    enabled: settings.paseoPlusPlus.sidebarBulkActions,
    expandAll: () => setAllCollapsed(false),
    collapseAll: () => setAllCollapsed(true),
  };
}
