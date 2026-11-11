import { describe, expect, it } from "vitest";
import type { CreateWorkspaceRequestOptions } from "@getpaseo/client/internal/daemon-client";
import {
  adoptedCheckoutAgent,
  existingWorktreeLabel,
  existingWorktreeOptionId,
  findExistingWorktreeByOptionId,
  openWorktreeForm,
  worktreeFormError,
  worktreeFormSource,
} from "./worktree-form-model";
const branch = (refName: string) => ({
  kind: "branch" as const,
  name: refName,
  refName,
  accessibilityLabel: refName,
});
const sourceInput = { cwd: "/repo", projectId: "project", refName: "refs/heads/main" };
describe("worktree form", () => {
  it("shares exact names by default and allows independent names when requested", () => {
    const form = openWorktreeForm("fresh-branch");
    form.setWorktreeName("shared-name");
    expect(worktreeFormSource(form.getState(), sourceInput)).toMatchObject({
      branchName: "shared-name",
      worktreeSlug: "shared-name",
    });
    form.setSeparateNames(true);
    form.setBranchName("feature/separate");
    expect(worktreeFormSource(form.getState(), sourceInput)).toMatchObject({
      branchName: "feature/separate",
      worktreeSlug: "shared-name",
    });
    form.setWorktreeName("different-directory");
    expect(form.getState().branchName).toBe("feature/separate");
    form.setSeparateNames(false);
    expect(worktreeFormSource(form.getState(), sourceInput)).toMatchObject({
      branchName: "different-directory",
      worktreeSlug: "different-directory",
    });
  });
  it("keeps invalid shared names visible for validation instead of silently rewriting them", () => {
    const form = openWorktreeForm("fresh-branch");
    form.setWorktreeName("feature/slash");
    expect(form.getState().branchName).toBe("feature/slash");
    expect(worktreeFormError(form.getState(), [])).toEqual({
      key: "worktreeOptions.invalidWorktreeName",
    });
  });

  it("defaults names from the checked out branch and retains manual edits across ref and mode changes", () => {
    const form = openWorktreeForm("Feature/My.Change");
    expect(form.getState().worktreeName).toBe("feature-my-change");
    form.setMode("checkout");
    form.applyRef(branch("refs/heads/Release/1.2"));
    expect(form.getState().worktreeName).toBe("release-1-2");
    form.setWorktreeName("my-checkout");
    form.applyRef(branch("refs/heads/other"));
    form.setMode("branch-off");
    form.setSeparateNames(true);
    form.setBranchName("New/Branch");
    expect(form.getState().worktreeName).toBe("my-checkout");
  });
  it("sends both explicit creation modes and adopts an existing checkout without worktree creation", () => {
    const form = openWorktreeForm("feature-new");
    form.setSeparateNames(true);
    form.setBranchName("feature/new");
    expect(worktreeFormSource(form.getState(), sourceInput)).toEqual({
      kind: "worktree",
      ...sourceInput,
      action: "branch-off",
      branchName: "feature/new",
      worktreeSlug: "feature-new",
      exactNames: true,
    });
    form.setMode("checkout");
    form.applyRef(branch("refs/heads/feature/existing"));
    expect(worktreeFormSource(form.getState(), sourceInput)).toEqual({
      kind: "worktree",
      cwd: "/repo",
      projectId: "project",
      action: "checkout",
      refName: "feature/existing",
      worktreeSlug: "feature-existing",
      exactNames: true,
    });
    form.selectExisting({ worktreePath: "/existing", branchName: "feature/existing" });
    expect(worktreeFormSource(form.getState(), sourceInput)).toEqual({
      kind: "directory",
      path: "/existing",
      projectId: "project",
    });
    form.applyScope("other-host:other-repo");
    expect(form.getState().existing).toBeNull();
  });
  it.each(["", "../escape", "UPPER", "two--hyphens", "-edge", "x".repeat(51)])(
    "rejects invalid worktree name %s",
    (name) => {
      const form = openWorktreeForm("feature");
      form.setSeparateNames(true);
      form.setWorktreeName(name);
      expect(worktreeFormError(form.getState(), [])).toEqual({
        key: "worktreeOptions.invalidWorktreeName",
      });
    },
  );
  it("keeps explicit intent identifiable when moving to an older host", () => {
    const form = openWorktreeForm("default-branch");
    expect(form.requiresCapability()).toBe(false);
    form.setBranchName("chosen-branch");
    form.applyScope("older-host:repo");
    expect(form.requiresCapability()).toBe(true);
    expect(form.getState().branchName).toBe("chosen-branch");
  });
  it("resets repository choices and derived defaults without overwriting manual names", () => {
    const form = openWorktreeForm("fresh-branch");
    form.applyScope("host:repo-a");
    form.setMode("checkout");
    form.applyRef(branch("refs/heads/repo-a-only"));
    form.selectExisting({ worktreePath: "/repo-a-checkout" });
    form.applyScope("host:repo-b");
    expect(form.getState()).toMatchObject({
      mode: "branch-off",
      checkoutBranch: "",
      existing: null,
      worktreeName: "fresh-branch",
    });
    form.setSeparateNames(true);
    form.setBranchName("chosen-new-branch");
    form.setWorktreeName("chosen-directory");
    form.setMode("checkout");
    form.applyScope("other-host:repo-b");
    expect(form.getState()).toMatchObject({
      mode: "branch-off",
      checkoutBranch: "",
      branchName: "chosen-new-branch",
      worktreeName: "chosen-directory",
    });
  });
  it("requires a branch and identifies the existing checkout when occupied", () => {
    const form = openWorktreeForm("feature");
    form.setBranchName("");
    expect(worktreeFormError(form.getState(), [])).toEqual({
      key: "worktreeOptions.enterNewBranchName",
    });
    form.setMode("checkout");
    form.setWorktreeName("checkout");
    expect(worktreeFormError(form.getState(), [])).toEqual({
      key: "worktreeOptions.chooseExistingBranch",
    });
    form.applyRef(branch("refs/heads/main"));
    expect(
      worktreeFormError(form.getState(), [{ worktreePath: "/repo", branchName: "main" }]),
    ).toEqual({ key: "worktreeOptions.branchCheckedOut", params: { path: "/repo" } });
    expect(worktreeFormError(form.getState(), [])).toBeNull();
  });
});

describe("existing worktree options", () => {
  const entries = [
    { worktreePath: "/worktrees/feature", branchName: "feature/a" },
    { worktreePath: "/worktrees/detached", branchName: null, head: "0123456789abcdef" },
  ];

  it("finds the checkout an option id refers to, and nothing for Local or New worktree", () => {
    expect(
      findExistingWorktreeByOptionId(entries, existingWorktreeOptionId("/worktrees/feature")),
    ).toBe(entries[0]);
    expect(findExistingWorktreeByOptionId(entries, "local")).toBeNull();
    expect(findExistingWorktreeByOptionId(entries, "worktree")).toBeNull();
  });

  it("labels a checkout by branch and path, and a detached one by its short head", () => {
    const formatDetached = (head: string) => `Detached ${head}`;
    expect(existingWorktreeLabel(entries[0]!, formatDetached)).toBe(
      "feature/a · /worktrees/feature",
    );
    expect(existingWorktreeLabel(entries[1]!, formatDetached)).toBe(
      "Detached 01234567 · /worktrees/detached",
    );
  });
});

describe("adoptedCheckoutAgent", () => {
  const agent: CreateWorkspaceRequestOptions["agent"] = {
    config: { provider: "claude", cwd: "/repo/packages/app" },
  };

  it("moves the first agent into an adopted checkout, keeping its subdirectory", () => {
    const adopted = adoptedCheckoutAgent({
      agent,
      sourceDirectory: "/repo",
      source: { kind: "directory", path: "/worktrees/existing", projectId: "project" },
    });

    expect(adopted?.config?.cwd).toBe("/worktrees/existing/packages/app");
  });

  it("keeps the drafted agent for the project directory and for new worktrees", () => {
    expect(
      adoptedCheckoutAgent({
        agent,
        sourceDirectory: "/repo",
        source: { kind: "directory", path: "/repo", projectId: "project" },
      }),
    ).toBe(agent);
    expect(
      adoptedCheckoutAgent({
        agent,
        sourceDirectory: "/repo",
        source: { kind: "worktree", cwd: "/repo", projectId: "project", worktreeSlug: "new" },
      }),
    ).toBe(agent);
  });
});

describe("plugin branch suggestions", () => {
  it("fills an untouched branch exactly, with a valid folder name beside it", () => {
    const form = openWorktreeForm("generated-name");

    form.applyPluginBranch("Feature/ABC-1");

    const state = form.getState();
    expect(state.branchName).toBe("Feature/ABC-1");
    expect(state.worktreeName).toBe("feature-abc-1");
    expect(state.separateNames).toBe(true);
    expect(worktreeFormSource(state, sourceInput)).toMatchObject({
      branchName: "Feature/ABC-1",
      worktreeSlug: "feature-abc-1",
    });
  });

  it("keeps shared names when the plugin branch is already a valid folder name", () => {
    const form = openWorktreeForm("generated-name");

    form.applyPluginBranch("plugin-branch");

    expect(form.getState()).toMatchObject({
      branchName: "plugin-branch",
      worktreeName: "plugin-branch",
      separateNames: false,
    });
  });

  it("lets a later plugin value replace an earlier one while the user has not typed", () => {
    const form = openWorktreeForm("generated-name");

    form.applyPluginBranch("first-branch");
    form.applyPluginBranch("second-branch");

    expect(form.getState().branchName).toBe("second-branch");
  });

  it("keeps what the user typed in the shared field over a plugin value", () => {
    const form = openWorktreeForm("generated-name");
    form.setWorktreeName("typed-name");

    form.applyPluginBranch("plugin-branch");

    expect(form.getState()).toMatchObject({ branchName: "typed-name", worktreeName: "typed-name" });
  });

  it("keeps what the user typed in the separate branch field over a plugin value", () => {
    const form = openWorktreeForm("generated-name");
    form.setSeparateNames(true);
    form.setBranchName("feature/typed");

    form.applyPluginBranch("plugin-branch");

    expect(form.getState().branchName).toBe("feature/typed");
  });

  it("fills the branch again once the user clears it", () => {
    const form = openWorktreeForm("generated-name");
    form.setWorktreeName("typed-name");
    form.applyPluginBranch("plugin-branch");
    form.setWorktreeName("");

    expect(form.getState()).toMatchObject({
      branchName: "plugin-branch",
      worktreeName: "plugin-branch",
    });
  });

  it("restores the generated default when the plugin withdraws an untouched fill", () => {
    const form = openWorktreeForm("generated-name");
    form.applyPluginBranch("Feature/ABC-1");

    form.applyPluginBranch(null);

    expect(form.getState()).toMatchObject({
      branchName: "generated-name",
      worktreeName: "generated-name",
      separateNames: false,
    });
  });

  it("changes nothing the user typed when the plugin withdraws", () => {
    const form = openWorktreeForm("generated-name");
    form.applyPluginBranch("Feature/ABC-1");
    form.setBranchName("feature/typed");

    form.applyPluginBranch(null);

    expect(form.getState()).toMatchObject({
      branchName: "feature/typed",
      worktreeName: "feature-typed",
      separateNames: true,
    });
  });

  it("does not use a plugin branch for checkout of an existing branch", () => {
    const form = openWorktreeForm("generated-name");
    form.setMode("checkout");

    form.applyPluginBranch("plugin-branch");
    form.applyRef(branch("refs/heads/main"));

    const source = worktreeFormSource(form.getState(), sourceInput);
    expect(source).toMatchObject({ action: "checkout", refName: "main" });
    expect(source).not.toHaveProperty("branchName");
  });
});
