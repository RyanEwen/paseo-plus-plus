import { createContext, useContext, type ReactNode } from "react";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { EMPTY_WORKSPACE_TREE, type WorkspaceTreeNode } from "./workspace-tree";

export interface WorkspaceFamilyDragAuthority {
  renderedGeneration: number;
  getGeneration: () => number;
}

export interface SidebarWorkspaceTreeModel {
  tree: ReadonlyMap<string, WorkspaceTreeNode>;
  revision: string;
  dragAuthority: WorkspaceFamilyDragAuthority | null;
  collapsedKeys: ReadonlySet<string>;
  activeWorkspaceKey: string | null;
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  humanAttentionWorkspaceKeys: ReadonlySet<string>;
}

const emptyModel: SidebarWorkspaceTreeModel = {
  tree: EMPTY_WORKSPACE_TREE,
  revision: "",
  dragAuthority: null,
  collapsedKeys: new Set(),
  activeWorkspaceKey: null,
  entries: new Map(),
  humanAttentionWorkspaceKeys: new Set(),
};
const WorkspaceTreeContext = createContext(emptyModel);

/** Share one collection projection with rows without one hot session-store selector per row. */
export function SidebarWorkspaceTreeProvider({
  value,
  children,
}: {
  value: SidebarWorkspaceTreeModel;
  children: ReactNode;
}) {
  return <WorkspaceTreeContext.Provider value={value}>{children}</WorkspaceTreeContext.Provider>;
}

export function useSidebarWorkspaceTree(): SidebarWorkspaceTreeModel {
  return useContext(WorkspaceTreeContext);
}
