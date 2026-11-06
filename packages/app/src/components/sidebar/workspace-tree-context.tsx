import { createContext, useContext, type ReactNode, type ReactElement } from "react";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { EMPTY_WORKSPACE_TREE, type WorkspaceTreeNode } from "./workspace-tree";

export const SIDEBAR_WORKSPACE_TITLE_LINE_HEIGHT = 20;

/** Row-only presentation, relative to each Project, Status or Pinned row's established rail. */
export interface SidebarWorkspaceFamilyPresentation {
  /** Cumulative child indentation in pixels; never applied to a row's highlight or drag cell. */
  contentIndent: number;
  disclosure: ReactElement | null;
  collapsedSummary: {
    id: string;
    description: string;
    content: ReactNode;
  } | null;
}

const emptyFamilyPresentation: SidebarWorkspaceFamilyPresentation = {
  contentIndent: 0,
  disclosure: null,
  collapsedSummary: null,
};
const WorkspaceFamilyPresentationContext = createContext(emptyFamilyPresentation);

/** Scope presentation to this row only; child branches each supply their own depth and summary. */
export function SidebarWorkspaceFamilyPresentationProvider({
  value,
  children,
}: {
  value: SidebarWorkspaceFamilyPresentation;
  children: ReactNode;
}) {
  return (
    <WorkspaceFamilyPresentationContext.Provider value={value}>
      {children}
    </WorkspaceFamilyPresentationContext.Provider>
  );
}

/** Read layout inputs without another session, settings or tree subscription in each row. */
export function useSidebarWorkspaceFamilyPresentation(): SidebarWorkspaceFamilyPresentation {
  return useContext(WorkspaceFamilyPresentationContext);
}

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
