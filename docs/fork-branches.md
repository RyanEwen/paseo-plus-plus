# Fork branches and upstream sync

Every fork feature has its own maintained branch, owner, tests and documentation. Maintain the fork assuming upstream never accepts those features. Upstream adoption is optional and does not gate fork completion or releases. The Paseo team may borrow our branches.

Preserve prepared upstream-facing branches and their qualification receipts as optional borrowing material. Do not require new counterparts or duplicate every subsequent fork change into them. Record the exact source and verification limits when one is used; its historical checks do not qualify later fork changes.

An upstream request does not authorize pushing or posting there.

Keep only our own branches locally and in the fork. Our clean upstream-facing feature branches are ours; imported upstream feature branches and published upstream mirrors are not. Fetch the upstream release tag the fork builds on into a private ref instead of creating an upstream branch.

## Layers

Fork branches form layers. Each layer holds only its own change on top of the layer below, so you can read, review, drop or upstream any piece on its own.

The fork builds on the newest tagged upstream release, betas included, and never on unreleased upstream `main`. Upstream cuts releases on release branches, so the newest tag is usually not on upstream `main`.

```mermaid
flowchart BT
  Upstream["Newest upstream release tag<br/>refs/upstream-release/&lt;tag&gt;"]
  Fixes["fix/upstream-bugs<br/>one commit per upstream bug"]
  Base["fork-base<br/>shared fork plumbing"]
  FeatureA["Feature branch"]
  FeatureB["Feature branch"]
  Stacked["Stacked feature<br/>builds on Feature B"]
  Integration["integration<br/>combined testing"]
  Main["main<br/>accepted layers, release source"]
  Upstream --> Fixes --> Base
  Base --> FeatureA
  Base --> FeatureB --> Stacked
  FeatureA --> Integration
  Stacked --> Integration
  Integration -->|accepted features| Main
```

| Layer               | Contains                                                                                                                                                                                                                                      | Never contains                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `fix/upstream-bugs` | The newest upstream release tag plus one commit per bug that also exists upstream. Each commit names the upstream issue or pull request it tracks, when one exists.                                                                           | Fork features or fork-only behaviour.                 |
| `fork-base`         | Plumbing every feature needs: the Paseo++ settings host and preferences store, shared registries (preference keys, settings list entries, locale keys, capability flags, README fork overview), seams, shared test tooling, dependency bumps. | Behaviour a user could switch off or drop on its own. |
| Feature branch      | One user-visible behaviour, built on `fork-base` or on the feature it needs.                                                                                                                                                                  | Other features' lines, or merges of `main`.           |
| `integration`       | Merges of feature tips for combined testing.                                                                                                                                                                                                  | Unaccepted work promoted to `main`.                   |
| `main`              | The merge of accepted layers; the release source.                                                                                                                                                                                             | Anything merged back down into a layer.               |

Follow these rules:

- Changes flow upward only. Merge a lower layer into the layers above it. Never merge `main` or `integration` into a feature.
- Give a behaviour its own branch when users can see, switch off or drop it independently. Combine work only when there is no separable behaviour.
- Build a feature that needs another feature on that feature's branch. Prefer a seam in `fork-base` when two features need each other only to register something.
- Put each feature's line in a shared list (preference defaults, settings list, locale files, README overview) in `fork-base`, so neighbouring features never conflict on adjacent lines. The feature still owns its behaviour and the line that renders it.
- A seam is a small, domain-neutral extension point in `fork-base`, such as the synced-settings key registry, that lets features register instead of importing each other. Label its commit `seam:`.
- An adapt commit gives a lower layer a neutral version of shared code so it builds alone; the feature above restores the full version. Label it `adapt:`. Merging every accepted layer must still produce `main`.
- Keep an upstream-bug fix in `fix/upstream-bugs` until upstream ships it, then drop the fork commit at the next sync. Carry a fix that a newer upstream commit supersedes until that commit is synced.

The fork is [RyanEwen/paseo-plus-plus](https://github.com/RyanEwen/paseo-plus-plus). Its default branch is `main`. This development checkout keeps the fork and upstream remotes separate:

| Ref or remote                              | Role                                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `fork`                                     | RyanEwen/paseo-plus-plus, the destination for fork work.                                       |
| `origin`                                   | getpaseo/paseo, fetched only for its release tags. No upstream writes.                         |
| `refs/upstream-release/<tag>`              | Private ref for the upstream release tag the layers build on; not a local or published branch. |
| `fix/upstream-bugs`                        | Bottom layer: the newest upstream release tag plus fixes for upstream bugs.                    |
| `fork-base`                                | Shared fork plumbing on top of `fix/upstream-bugs`.                                            |
| Fork feature branches                      | One feature each, on `fork-base` or a parent feature; receive changes from layers below.       |
| `integration`, tracking `fork/integration` | Long-lived combined testing branch for selected feature tips.                                  |
| `main`, tracking `fork/main`               | Accepted layers; release source.                                                               |
| Preserved upstream-facing feature branches | Optional borrowing material with recorded source and verification limits.                      |
| Temporary review branches                  | Optional bounded reviews before combination in `integration`.                                  |

Inspect actual remote URLs and full heads when adopting a checkout. A ref's name does not prove its destination or that two mirrors are synchronized. Do not retarget `origin` to make an inherited upstream command operate on the fork.

Start each new feature from a freshly fetched `fork-base`, or from the feature it builds on, in its own branch and workspace under the existing Paseo project, with one accountable owner. Resume that owner for follow-up work. Record the base SHA; do not inherit unpublished work from a local branch by accident. The app's starting-ref behavior is described in [development](development.md#worktree-starting-refs).

Keep implementation and follow-up fixes on the owning branch. Merge feature tips into `integration` to test them together. Resolve defects on their owning branches, then bring those fixes into `integration`; record shared-file conflict resolutions with their owners. Do not leave a feature fix only in the combined working tree or a private patch directory.

`integration` is long-lived and can contain work not yet accepted for `main`. After combined review and qualification, merge the accepted feature tips into `main`. Do not merge all of `integration` into `main` while it contains unaccepted features.

Use the states below to distinguish prepared source, qualification, combination and publication. A `review/*` branch is optional and temporary. Coordinate branch or workspace renames with active owners, preserve unfinished work first, and keep paths stable when tools or evidence reference them. A folder named `preview-distribution` does not select a release branch.

Legacy `ryan/preview` refs can still contain unpublished commits or serve existing workspace comparison targets. Preserve those refs and their exact base SHAs until reviewed reconciliation and explicit owner comparison-ref migration. Do not bulk-push their commits, prune them, rename active workspaces, or silently replace their bases with `main`. Historical QA receipts retain the branch names and source hashes that were actually qualified; they do not define today's workflow.

## Sync upstream through the layers

Invoke `/sync-fork` in Claude or `$sync-fork` in Codex to bring the newest upstream release into the layers and integrate accepted changes. The repository skill lives in `.agents/skills/sync-fork`; `.claude/skills/sync-fork` links to it. This section owns the workflow.

Invocation authorizes normal local commits and merges needed for this integration within current session permissions. It does not authorize upstream writes, resets, force-pushes, deletions, releases, daemon restarts, or blanket acceptance of unfinished work. Publish to the fork only when the session authorizes it; do not repeat confirmations already answered. Stop dependent mutations when ownership, acceptance, or permissions remain unresolved, and report the exact blocker.

```mermaid
flowchart LR
  Fetch["Fetch the newest release tag"] --> Fixes["Move fix/upstream-bugs onto it<br/>drop fixes the release ships"]
  Fixes --> Base["Merge into fork-base"]
  Base --> Features["Merge each parent into its features,<br/>bottom up"]
  Features --> Integration["Assemble integration<br/>and qualify"]
  Integration --> Main["Merge accepted tips into main"]
```

1. Inspect actual fetch and push URLs, worktrees, full local and remote heads, tracking refs, dirty work, and unpublished commits. Inventory each layer with its owner and parent. Record each starting SHA. Preserve dirty and unpublished work with its owner; a sync request does not authorize committing unrelated changes or moving active workspaces.
2. Verify `fork` targets RyanEwen/paseo-plus-plus and `origin` targets getpaseo/paseo before fetching. Record the release tag the layers are on now. Pick the newest upstream tag; betas count. Fetch it into a private ref and record its SHA. Never reset a fork branch to it or publish it as a branch.

   ```bash
   git ls-remote --tags --refs origin 'v*' | sort -V -k2
   git fetch --no-tags origin "refs/tags/<tag>:refs/upstream-release/<tag>"
   ```

3. Move `fix/upstream-bugs` onto the new tag: merge the tag into it, or rebuild it on the tag. Drop each fork fix that the release ships and each fix for a bug that only exists in unreleased upstream code. Keep the rest as one commit each, and record which release commits superseded which fork commits. When the layers sit on a commit that no release contains (for example, after a sync from upstream `main`), merging would bring unreleased code with it. Instead, rebuild each layer on the release by replaying its own commits with `git cherry-pick -x`, bottom up, as the move to `v0.15.3` did.
4. Merge `fix/upstream-bugs` into `fork-base` and resolve plumbing conflicts there. Review the [fork overview](release.md#fork-overview-review) for additions upstream now provides.
5. Have each feature owner merge its parent into its branch, bottom up: features on `fork-base` first, then stacked features after their parents. Resolve conflicts on the owning branch and qualify changed behaviour one heavy check at a time through the [visible queue](worktree-development.md#run-checks-through-a-visible-queue). Reuse unchanged evidence and keep source SHAs and platform limits explicit.
6. Assemble `integration` from feature tips and run combined qualification. Merge only reviewed, accepted feature tips into `main`; keep unfinished or unqualified work pending.
7. Report the before and after release tags and exact SHAs for every layer; accepted and deferred changes; dropped upstream fixes; preserved unpublished work and refs; check results and limitations; and whether changes are local or published. Do not claim completion for blocked branches or qualification that has not run.

Release only the exact validated fork integration SHA through [fork preview distribution](release.md#fork-preview-distribution). Temporary release coordination is covered by [release branch discipline](release.md#release-branch-discipline). Published-owner archival follows [released feature workspaces](release.md#released-feature-workspaces); it is separate from source integration and review assembly.
