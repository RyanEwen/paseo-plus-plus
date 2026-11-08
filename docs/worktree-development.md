# Worktree development and integration

Use this workflow for concurrent feature work in the Paseo monorepo. Follow your shared agent
rules for ownership and approval. This guide covers the repository-specific environment,
validation, and integration steps. Branch roles, layers and upstream sync are in
[fork branches](fork-branches.md).

## Work moves through explicit states

| State     | What is established                                                       | What remains                                 |
| --------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| Prepared  | The owner has a reviewable source change and focused regression coverage. | Checks and runtime qualification.            |
| Qualified | The declared checks passed against a recorded source and environment.     | Integration with other changes.              |
| Assembled | The review preview contains the selected owner changes.                   | Combined checks and review.                  |
| Merged    | Authorized commits are integrated into the destination branch.            | Exact-source CI and packaging.               |
| Published | The authorized release and required assets are available and verified.    | Any explicitly unverified device acceptance. |

Record platform coverage separately. A browser pass does not qualify Android native code, and a
source fix does not change the running daemon. Packaging and device acceptance have different
prerequisites; follow [QA](qa.md) and the [release playbook](release.md).

```mermaid
flowchart LR
Owners[Feature branches] --> Checks[Validation queue]
Checks --> Preview[integration]
Preview --> Review[Combined checks and review]
Review --> Merge[Accepted features in main]
Merge --> Preview
Merge --> CI[Exact-source CI]
  CI --> Release[Authorized publication]
```

## Qualify the environment before implementation

Paseo's configured `paseo.json` worktree setup installs the lockfile dependencies, seeds isolated
dev state, and builds the server stack. Inspect the setup before invoking it: directory adoption
and managed worktree creation have different setup behavior. When package installation is outside
the task's authorization, do not trigger a setup hook that runs `npm ci`.

Prepare the worktree once, with a recorded base commit, lockfile, toolchain, and dependency source.
Confirm the following before spending time on feature checks:

- Root dependencies and package-local dependencies resolve from the intended environment.
- Package aliases refer to the owning checkout; generated declarations match the producing source.
- Vite, TypeScript, and other writable caches have worktree-local destinations.
- Runtime qualification has the required browser or native SDK and generated project.

A bare root `node_modules` symlink is not a qualified environment. This repository also has
package-local overrides, including app and Expo module dependencies. Missing those entries can
produce missing-module errors while the root dependency tree appears populated. Shared writable
caches can also send Vite's temporary configuration output outside the owner's writable directory.

If you reuse prepared dependencies, treat the source tree as read-only. Keep writable caches and
build outputs local, reuse package-local entries as well as root entries, and verify compatibility
with the owner's lockfile and toolchain. Record any required physical copies from the qualified
source. Do not install packages or change shared dependencies as an unreported setup repair.

For missing generated types, rebuild the producer using the
[owning package targets](development.md#built-workspace-packages). Do not add duplicate types or
annotate callbacks to hide stale declarations. A missing Android SDK or generated native project
is an environment limitation, not a reason to claim a browser check qualifies Kotlin.

Directory adoption can register a worktree as a new project when the source project identity is
omitted. Record the canonical project ID and pass it explicitly when adopting a prepared Git
worktree into Paseo. Confirm the returned project and workspace IDs before launching its agent.

## Budget disk space and retain work deliberately

On WSL, check both Linux filesystem space and the Windows drive holding its virtual disk. Linux
can report a large remaining virtual capacity while the Windows drive is nearly full. See
[Microsoft's disk-space guide](https://learn.microsoft.com/en-us/windows/wsl/disk-space).

Measure source, installed dependencies, generated outputs, and saved evidence separately. Avoid
copying a complete installed dependency tree into every worktree when the dependency set is
unchanged. Reuse qualified immutable inputs and keep workspace-linked packages and writable
caches local. Cache reuse needs the lockfile, package patches, toolchain, and native ABI to match.

Container images and package caches do not make disk usage disappear. Reuse their immutable
layers without creating a separate dependency volume for every feature by default. A workspace
setup preflight should report expected disk growth and available host space before installing or
copying large trees.

Keep source and evidence retention separate from disposable build caches. Before cleanup, record
which directories are referenced by active workspaces, dependency links, and unfinished review or
release evidence. Present exact cleanup candidates and expected savings; do not broadly delete
`.dev` or dependency directories because their names look temporary.

[Workspace archive and recovery](agent-lifecycle.md#archive) have different guarantees from
retaining a source backup. Save unfinished work and verify its repository references before
archiving a managed worktree. Freeing Linux files and reclaiming space from the host virtual disk
are separate operations; do not interrupt running WSL services to compact the disk during work.

## Run checks through a visible queue

For this constrained WSL workflow, run one heavy validation operation at a time, using two CPUs
from the process's allowed CPU set. Owners can read source and prepare independent changes while
another owner holds the slot. A grant names the owner, allowed checks, and release condition.

Use the existing focused suites and real runtime fixtures described in [testing](testing.md).
Preserve failure logs before repairing the source or environment. Do not retry an unchanged
failure blindly, weaken assertions to get green, or rerun unchanged checks already reported green.
The full local suite remains outside this workflow; use CI for broad verification.

Each qualification handoff records:

- Branch, base commit, current commit, and the uncommitted patch or file hashes.
- Changed paths and any shared-file overlaps with other owners.
- Exact commands, results, logs, and runtime captures for the source that was checked.
- Platform limits, pending product decisions, and fixture teardown evidence.

Release the slot explicitly. Source preparation, a passing focused test, and a complete feature
qualification are separate outcomes; name the outcome that the evidence supports.

## Assemble a review preview deliberately

Use `integration` for the combined preview. Record which feature commits are included and which
remain unaccepted. A checkpoint of an existing mixed working tree preserves work during
reconciliation; it does not establish that its changes belong to clean feature branches. Retire
that exception by assigning and restoring the changes to their owners before promotion to `main`.

Keep the review preview separate from the running production daemon and its state. Use
[checkout-local dev homes and assigned service ports](development.md#running-the-dev-server) for
fixtures. A browser preview may connect to an existing daemon without controlling its lifecycle.

Take a snapshot before combining owner changes. Use the owner's recorded patch base when applying
a delta. Compare shared files such as `workspace-screen.tsx`, `left-sidebar.tsx`, locale resources,
and README against that base. Do not overwrite an assembled file with a whole older owner copy.
Resolve overlapping changes deliberately and keep the original owner patches available.

A live preview can refresh for user review. Qualification needs a frozen source: do not edit its
inputs while a browser or native case is running. Record the source identity alongside screenshots.

After assembly, run the required combined static checks and the integration cases justified by
changed interactions or resolved conflicts. Reuse unchanged owner results; do not call their
results proof of new integration behavior. Keep unqualified native changes visible in the status.
