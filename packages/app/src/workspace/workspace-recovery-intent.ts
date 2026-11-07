import { useLayoutEffect } from "react";
import { create } from "zustand";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

/**
 * Workspace-only recovery requests made from the project archive chooser, keyed like workspace
 * layout state (`serverId:workspaceId`).
 *
 * The request lives in memory rather than in the route: internal navigation never hands off
 * through query parameters (docs/expo-router.md), and a reload or bookmark must not replay it.
 */
interface WorkspaceRecoveryIntentState {
  requested: Readonly<Record<string, true>>;
}

const useWorkspaceRecoveryIntentStore = create<WorkspaceRecoveryIntentState>(() => ({
  requested: {},
}));

/**
 * Ask the destination workspace screen to open its recovery confirmation, without selecting or
 * unarchiving an agent. Call before navigating so the screen sees the request on mount.
 */
export function requestWorkspaceRecovery(target: { serverId: string; workspaceId: string }): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(target);
  if (!workspaceKey) {
    return;
  }
  useWorkspaceRecoveryIntentStore.setState((state) => ({
    requested: Object.assign({}, state.requested, { [workspaceKey]: true as const }),
  }));
}

/** Drop a request once its workspace exists again; recovery has nothing left to do. */
export function consumeWorkspaceRecoveryRequest(workspaceKey: string): void {
  useWorkspaceRecoveryIntentStore.setState((state) => {
    const { [workspaceKey]: _consumed, ...requested } = state.requested;
    return { requested };
  });
}

/** Whether a recovery request is waiting for this workspace key. */
export function isWorkspaceRecoveryRequested(workspaceKey: string | null): boolean {
  return (
    workspaceKey !== null && workspaceKey in useWorkspaceRecoveryIntentStore.getState().requested
  );
}

/**
 * Read the recovery request for the workspace a screen shows. The request stays while the
 * workspace is absent (archived), and is consumed once the workspace exists, so a restored
 * workspace does not reopen the confirmation later.
 */
export function useWorkspaceRecoveryRequested(input: {
  workspaceKey: string | null;
  workspaceExists: boolean;
}): boolean {
  const { workspaceKey, workspaceExists } = input;
  const requested = useWorkspaceRecoveryIntentStore(
    (state) => workspaceKey !== null && workspaceKey in state.requested,
  );
  useLayoutEffect(() => {
    if (requested && workspaceExists && workspaceKey) {
      consumeWorkspaceRecoveryRequest(workspaceKey);
    }
  }, [requested, workspaceExists, workspaceKey]);
  return requested;
}
