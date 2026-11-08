import {
  useWorkspaceTabLaunchCatalog,
  type WorkspaceTabLaunchItem,
} from "@/workspace-tabs/launcher";
import { WorkspaceNewTabMenuItem } from "./workspace-new-tab-menu";

const NO_PLUGIN_PANELS: readonly WorkspaceTabLaunchItem[] = [];

/**
 * Plugin panels from the launch catalog for the compact workspace menu.
 *
 * Call this outside the menu content. The catalog reads the workspace's new-tab launcher
 * context, and compact sheet content renders through a portal at the app root, where that
 * context does not exist (docs/floating-panels.md, Gotcha 7).
 *
 * @param serverId - Host whose installed plugins supply the panels.
 * @returns The launchable panels, empty when no plugin contributes one.
 */
export function useCompactPluginPanelItems(serverId: string): readonly WorkspaceTabLaunchItem[] {
  const launchGroups = useWorkspaceTabLaunchCatalog({
    serverId,
    purpose: "primary",
    host: "main",
    surface: "menu",
  });
  const pluginPanels = launchGroups.find((group) => group.id === "plugin-panels");
  return pluginPanels?.items ?? NO_PLUGIN_PANELS;
}

interface CompactPluginPanelMenuItemsProps {
  items: readonly WorkspaceTabLaunchItem[];
}

/** Menu rows for plugin panels. Compact layouts have no tab strip to open them from. */
export function CompactPluginPanelMenuItems({ items }: CompactPluginPanelMenuItemsProps) {
  return (
    <>
      {items.map((item) => (
        <WorkspaceNewTabMenuItem key={item.id} item={item} />
      ))}
    </>
  );
}
