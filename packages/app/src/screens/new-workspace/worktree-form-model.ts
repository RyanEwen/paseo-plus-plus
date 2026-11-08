import { isValidWorktreeName, slugify } from "@getpaseo/protocol/branch-slug";
import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { PickerItem } from "../new-workspace-picker-item";
import { remapDraftCwdToWorkspace } from "../new-workspace-fork-context";

export interface ExistingWorktree {
  worktreePath: string;
  branchName?: string | null;
  head?: string | null;
}

const EXISTING_WORKTREE_OPTION_PREFIX = "existing:";

/** Isolation picker option id for adopting an existing checkout. */
export function existingWorktreeOptionId(worktreePath: string): string {
  return `${EXISTING_WORKTREE_OPTION_PREFIX}${worktreePath}`;
}

/** The existing checkout an isolation option id refers to, or null for Local and New worktree. */
export function findExistingWorktreeByOptionId(
  entries: readonly ExistingWorktree[] | undefined,
  optionId: string,
): ExistingWorktree | null {
  return (
    entries?.find((entry) => existingWorktreeOptionId(entry.worktreePath) === optionId) ?? null
  );
}

/**
 * Branch and absolute path distinguish checkout rows, including detached worktrees.
 * `formatDetached` supplies the translated label for a detached short head.
 */
export function existingWorktreeLabel(
  entry: ExistingWorktree,
  formatDetached: (head: string) => string,
): string {
  const branch = entry.branchName ?? formatDetached(entry.head?.slice(0, 8) ?? "HEAD");
  return `${branch} · ${entry.worktreePath}`;
}

/** Local branch name for a local or remote-tracking ref. */
export function branchNameFromRef(refName: string): string {
  return refName.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "");
}

/** Owns explicit branch intent and editable names independently of async picker data. */
export function openWorktreeForm(initialBranch: string) {
  const listeners = new Set<() => void>();
  let state = {
    mode: "branch-off" as "branch-off" | "checkout",
    branchName: slugify(initialBranch),
    checkoutBranch: "",
    worktreeName: slugify(initialBranch),
    nameEdited: false,
    separateNames: false,
    existing: null as ExistingWorktree | null,
    scope: "",
  };
  function publish(patch: Partial<typeof state>) {
    state = { ...state, ...patch };
    if (!state.nameEdited) {
      state.worktreeName = slugify(
        state.mode === "branch-off" ? state.branchName : state.checkoutBranch,
      );
    }
    if (!state.separateNames && state.mode === "branch-off") {
      state.branchName = state.worktreeName;
    }
    listeners.forEach((listener) => listener());
  }
  return {
    getState: () => state,
    // An older host must not silently discard choices made on a capable host.
    requiresCapability: () =>
      state.existing !== null ||
      state.mode === "checkout" ||
      state.nameEdited ||
      state.branchName !== slugify(initialBranch),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => listeners.clear(),
    applyScope(scope: string) {
      if (scope === state.scope) return;
      // Checkout intent belongs to its repository. Keep typed names, but recompute defaults.
      publish({ scope, existing: null, mode: "branch-off", checkoutBranch: "" });
    },
    applyRef(item: PickerItem | null) {
      const checkoutBranch =
        item?.kind === "branch" ? branchNameFromRef(item.refName) : (item?.item.headRefName ?? "");
      if (checkoutBranch !== state.checkoutBranch) publish({ checkoutBranch });
    },
    setMode: (mode: typeof state.mode) => publish({ mode }),
    setBranchName(branchName: string) {
      publish({
        branchName,
        ...(!state.separateNames && state.mode === "branch-off"
          ? { worktreeName: branchName, nameEdited: true }
          : {}),
      });
    },
    setWorktreeName(worktreeName: string) {
      publish({
        worktreeName,
        nameEdited: true,
      });
    },
    /** Joining names keeps the visible worktree name; submission validates it for both. */
    setSeparateNames(separateNames: boolean) {
      publish({
        separateNames,
        ...(!separateNames ? { branchName: state.worktreeName } : {}),
      });
    },
    selectExisting: (existing: ExistingWorktree | null) => publish({ existing }),
  };
}

export type WorktreeFormModel = ReturnType<typeof openWorktreeForm>;

/** A validation failure as a translation key, so this model stays free of React and i18n. */
export type WorktreeFormError =
  | { key: "worktreeOptions.enterNewBranchName" }
  | { key: "worktreeOptions.invalidWorktreeName" }
  | { key: "worktreeOptions.chooseExistingBranch" }
  | { key: "worktreeOptions.branchCheckedOut"; params: { path: string } };

/** Validates exact names and branch occupancy before submission; the host repeats Git checks. */
export function worktreeFormError(
  state: ReturnType<WorktreeFormModel["getState"]>,
  worktrees: readonly ExistingWorktree[],
): WorktreeFormError | null {
  if (state.mode === "branch-off" && !state.branchName.trim()) {
    return { key: "worktreeOptions.enterNewBranchName" };
  }
  if (!isValidWorktreeName(state.worktreeName)) {
    return { key: "worktreeOptions.invalidWorktreeName" };
  }
  if (state.mode === "checkout") {
    if (!state.checkoutBranch) return { key: "worktreeOptions.chooseExistingBranch" };
    const occupied = worktrees.find((entry) => entry.branchName === state.checkoutBranch);
    if (occupied) {
      return { key: "worktreeOptions.branchCheckedOut", params: { path: occupied.worktreePath } };
    }
  }
  return null;
}

/** Produces the existing workspace transport without creating a worktree for adoption. */
export function worktreeFormSource(
  state: ReturnType<WorktreeFormModel["getState"]>,
  input: { cwd: string; projectId: string; refName?: string },
): CreateWorkspaceRequestOptions["source"] {
  if (state.existing)
    return { kind: "directory", path: state.existing.worktreePath, projectId: input.projectId };
  return {
    kind: "worktree",
    cwd: input.cwd,
    projectId: input.projectId,
    exactNames: true,
    worktreeSlug: state.worktreeName,
    action: state.mode,
    refName: state.mode === "checkout" ? state.checkoutBranch : input.refName,
    ...(state.mode === "branch-off" ? { branchName: state.branchName.trim() } : {}),
  };
}

/**
 * The first agent for a workspace request. The composer drafts against the project directory,
 * so when the request adopts another checkout the agent's cwd moves into that checkout,
 * keeping its subdirectory. Any other request keeps the agent as drafted.
 */
export function adoptedCheckoutAgent(input: {
  agent: CreateWorkspaceRequestOptions["agent"];
  sourceDirectory: string;
  source: CreateWorkspaceRequestOptions["source"];
}): CreateWorkspaceRequestOptions["agent"] {
  const { agent, sourceDirectory, source } = input;
  const adoptsAnotherCheckout = source.kind === "directory" && source.path !== sourceDirectory;
  if (!agent?.config || !adoptsAnotherCheckout) {
    return agent;
  }
  const cwd = remapDraftCwdToWorkspace({
    cwd: agent.config.cwd,
    sourceDirectory,
    workspaceDirectory: source.path,
  });
  return { ...agent, config: { ...agent.config, cwd } };
}
