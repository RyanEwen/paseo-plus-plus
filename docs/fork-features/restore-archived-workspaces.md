# Restore archived workspaces

Choose **Restore archived workspace** from a project's menu to browse that project's archive on every host it is open on. Select a workspace to review and confirm recovery. Restoring the workspace leaves archived agents archived. Removed worktrees recover from Git; uncommitted changes and untracked files are not recovered.

Choose **Archive all** from the same menu to archive the project's active workspaces and agents on every host while keeping the project. The confirmation shows the workspace, agent, running agent and host counts. Background workspaces are included only when you turn on their separate switch, which starts off. Worktrees with uncommitted or unpushed work ask for confirmation first, as a single archive does. Workspaces are archived one at a time; a failure stops the batch and leaves the remaining workspaces untouched so you can retry. If the project changes while the confirmation is open, nothing is archived.
