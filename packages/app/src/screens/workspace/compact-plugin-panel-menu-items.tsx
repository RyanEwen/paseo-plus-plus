import { useWorkspaceTabLaunchCatalog } from "@/workspace-tabs/launcher";
import { WorkspaceNewTabMenuItem } from "./workspace-new-tab-menu";

interface CompactPluginPanelMenuItemsProps {
  serverId: string;
}

/**
 * Plugin panels from the launch catalog, as rows of the compact workspace menu.
 * Compact layouts have no tab strip, so this menu is where plugin panels are opened.
 */
export function CompactPluginPanelMenuItems({ serverId }: CompactPluginPanelMenuItemsProps) {
  const launchGroups = useWorkspaceTabLaunchCatalog({
    serverId,
    purpose: "primary",
    host: "main",
    surface: "menu",
  });
  const pluginPanels = launchGroups.find((group) => group.id === "plugin-panels");
  if (!pluginPanels) {
    return null;
  }
  return (
    <>
      {pluginPanels.items.map((item) => (
        <WorkspaceNewTabMenuItem key={item.id} item={item} />
      ))}
    </>
  );
}
