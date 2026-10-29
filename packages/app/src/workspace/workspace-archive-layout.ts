import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { WorkspaceArchiveTarget } from "./workspace-archive";

/** Caller-owned tab cleanup after archive success. Failed or unprocessed targets retain their tabs. */
export function purgeArchivedWorkspaceState(input: WorkspaceArchiveTarget): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (workspaceKey) {
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
  }
}
