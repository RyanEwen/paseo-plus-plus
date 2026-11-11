import { isValidWorktreeName, slugify } from "@getpaseo/protocol/branch-slug";
import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import { branchNameFromRef, type PickerItem } from "../new-workspace-picker-item";
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
    /** The user typed the new branch name (the shared field, or the separate branch field). */
    branchEdited: false,
    /** A plugin's `setBranch` value; it fills the branch only while the user has not typed one. */
    pluginBranch: null as string | null,
    /** Separate names were turned on only to hold a plugin branch that is not a valid folder name. */
    separatedForPlugin: false,
    existing: null as ExistingWorktree | null,
    scope: "",
  };
  /** Whether the user has typed a branch name that is still there, in whichever field holds it. */
  function userOwnsBranch(): boolean {
    const typed = state.separateNames ? state.branchName : state.worktreeName;
    return state.branchEdited && typed.trim() !== "";
  }
  /** The plugin branch currently filling the new branch name, if any. */
  function activePluginBranch(): string | null {
    if (state.mode !== "branch-off" || userOwnsBranch()) return null;
    return state.pluginBranch;
  }
  function publish(patch: Partial<typeof state>) {
    state = { ...state, ...patch };
    const pluginBranch = activePluginBranch();
    if (pluginBranch === null) {
      applyDerivedNames();
    } else {
      applyPluginFill(pluginBranch);
    }
    listeners.forEach((listener) => listener());
  }
  /**
   * A plugin branch is kept exactly. The folder follows it unless the user named the folder,
   * and names separate when the branch is not a valid folder name.
   */
  function applyPluginFill(branch: string) {
    state.branchName = branch;
    if (!state.nameEdited || state.worktreeName.trim() === "") {
      state.worktreeName = slugify(branch);
    }
    if (!state.separateNames && state.worktreeName !== branch) {
      state.separateNames = true;
      state.separatedForPlugin = true;
    }
  }
  function applyDerivedNames() {
    if (state.separatedForPlugin && state.pluginBranch === null) {
      state.separateNames = false;
      state.separatedForPlugin = false;
    }
    if (!state.nameEdited) {
      state.worktreeName = slugify(
        state.mode === "branch-off" ? state.branchName : state.checkoutBranch,
      );
    }
    if (!state.separateNames && state.mode === "branch-off") {
      state.branchName = state.worktreeName;
    }
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
        branchEdited: true,
        // The user now relies on the separate field, so withdrawing a plugin branch keeps it.
        separatedForPlugin: false,
        ...(!state.separateNames && state.mode === "branch-off"
          ? { worktreeName: branchName, nameEdited: true }
          : {}),
      });
    },
    setWorktreeName(worktreeName: string) {
      // With shared names this field is also the branch name.
      const sharesBranch = !state.separateNames && state.mode === "branch-off";
      publish({
        worktreeName,
        nameEdited: true,
        ...(sharesBranch ? { branchEdited: true } : {}),
      });
    },
    /**
     * Joining names keeps the visible worktree name; submission validates it for both. Joining
     * is the user choosing the folder name as the branch, so a plugin branch stops filling it.
     */
    setSeparateNames(separateNames: boolean) {
      publish({
        separateNames,
        separatedForPlugin: false,
        ...(!separateNames ? { branchName: state.worktreeName, branchEdited: true } : {}),
      });
    },
    /**
     * Record a plugin's `setBranch` value. It fills the new branch name only while the user has
     * not typed one or has cleared it; null withdraws the suggestion.
     */
    applyPluginBranch(pluginBranch: string | null) {
      if (pluginBranch === state.pluginBranch) return;
      // Withdrawing a suggestion that filled the field restores the generated default.
      const withdrawsFill = pluginBranch === null && activePluginBranch() !== null;
      publish({
        pluginBranch,
        ...(withdrawsFill ? { branchName: slugify(initialBranch) } : {}),
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
