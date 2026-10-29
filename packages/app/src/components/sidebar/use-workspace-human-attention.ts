import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { createWorkspaceHumanAttentionSelector } from "./workspace-tree-attention";

/** One audience-aware attention subscription serves the entire sidebar collection. */
export function useWorkspaceHumanAttention(workspaces: readonly SidebarWorkspacePlacement[]) {
  const select = useMemo(() => createWorkspaceHumanAttentionSelector(workspaces), [workspaces]);
  return useSessionStore((state) => select(state.sessions));
}
