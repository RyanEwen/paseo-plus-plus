# Provider history safety, preview and migration guidance

Use a fully provisioned Codex or Claude profile to bind new Paseo chats to its own history storage. Inspect existing history read-only, then copy migration guidance to an agent for review. Paseo has no built-in migration apply or recovery command, and a configured profile neither moves existing chats nor hides them from a native app.

## Bind a configured Codex profile

Opt in on the exact provider entry in `$PASEO_HOME/config.json`:

```json
{
  "agents": {
    "providers": {
      "codex-work": {
        "extends": "codex",
        "label": "Work",
        "history": { "mode": "configured" },
        "env": { "CODEX_HOME": "/absolute/configured-codex-home" },
        "options": { "sqlite_home": "/absolute/configured-codex-sqlite" }
      }
    }
  }
}
```

- Both directories must already exist with the account and config your installed Codex needs. Paseo does not create a home, copy credentials, sign in or sync integrations.
- Choose history and database roots separate from Codex's native default storage. `sqlite_home` is required because config-file and environment selectors have different precedence; it is passed as a startup option, never per thread, and is left out of the options Paseo sends to the app. It cannot change while a session is running.
- Configured startup admits only `codex-cli 0.166.0`. Other versions, replace-command wrappers, native `--profile` selectors and conflicting SQLite selectors fail before app-server starts.
- `mode: "shared"`, or no `history` entry, keeps the existing launch behavior. Remove `sqlite_home` from an unbound shared profile.

## Bind a configured Claude profile

```json
{
  "agents": {
    "providers": {
      "claude-work": {
        "extends": "claude",
        "label": "Work",
        "history": { "mode": "configured" },
        "env": { "CLAUDE_CONFIG_DIR": "/absolute/configured-claude-home" }
      }
    }
  }
}
```

- The home must already be a working Claude profile. Paseo keeps the exact `CLAUDE_CONFIG_DIR` spelling and any secure-storage selector; it does not create the home, touch credentials or Keychain entries, sign in, or sync settings, plugins or MCP resources.
- Replace wrappers, appended command arguments, nonempty `extraArgs` and a project-namespace override fail before the SDK starts.
- Paseo audits the home once each time it opens a session: native default roots, the project namespace, and links in history and checkpoint files. Before each prompt and query it checks only that `CLAUDE_CONFIG_DIR` still selects the bound home, so a link added after launch is not caught until the next launch. A rewind also checks that its new transcript is an ordinary file inside the home.
- A home with more than 10,000 history entries still runs. Paseo checks the first 10,000, skips the rest, and shows a warning in the chat.
- Use Paseo's rewind controls to rewind conversation, files or both. `/clear`, `/new`, `/fork`, `/resume` and `/rewind` typed as text are refused in a bound chat, because they would switch sessions outside the binding.
- Rewinding to the beginning clears the view and keeps the old conversation as the recovery handle until your next prompt starts the new one. A combined rewind rewinds files first, so a later conversation failure can leave files rewound.

## What a binding guarantees

Paseo records the exact home (and Codex SQLite home) on the agent before it creates or imports a session, and checks it again on resume, reload, archive and restore.

- A changed profile reports `HISTORY_STORAGE_CONFLICT`; restore the recorded settings to resume. Reload checks the route before closing the current session.
- Enabling the policy never moves or rebinds existing native, imported or legacy sessions. An unbound session reports `existing-route-unverified`; keep using its original shared profile.
- A bound chat stays guarded if the policy is later removed. Imports keep their native IDs and imported provenance; provider-managed children without a known binding cannot resume through the guarded route.
- The guard rejects native default roots and symlinked or hardlinked history and database paths. Auth, config and integration links are not checked.

## Preview a migration

Inspect a source home without starting a provider or daemon:

```sh
paseo provider history preview codex --home /absolute/paseo-home --provider-home /absolute/codex-home --json
paseo provider history preview claude --home /absolute/paseo-home --provider-home /absolute/claude-home --json
```

Add `--family codex` or `--family claude` for a custom provider ID, and `--sqlite-home` when Codex stores SQLite separately. To compare with an existing configured Codex destination, add `--destination-provider codex-work`; it reports source overlap, colliding session IDs and destination issues.

The report lists managed candidates, native-only sessions, Codex parent, fork and spawn links, missing session files, supporting artifacts and conflicts, with paths, IDs, sizes and hashes but no transcript content. Every report has `applySupported: false`. Its digest identifies the inventory; it is not approval to migrate.

## Copy migration guidance

In **Provider settings**, open a provider's actions menu and choose **Copy migration prompt**. The prompt names the provider, records `inventoryPerformed: false`, and contains no paths or session IDs. Copying never launches an agent, runs a provider, reads history or grants permission to migrate.

For guidance that includes a read-only preview:

```sh
paseo provider history migration-prompt codex --home /absolute/paseo-home --provider-home /absolute/source-codex-home --sqlite-home /absolute/source-sqlite-home --destination-home /absolute/configured-codex-home --destination-sqlite-home /absolute/configured-sqlite-home
paseo provider history migration-prompt claude --home /absolute/paseo-home --provider-home /absolute/source-claude-home --destination-home /absolute/configured-claude-home
```

The destination is an unverified proposal. `--json` returns the text and its bounded context; check the omission counts and issues. The guidance asks your agent to establish the installed backend and storage contract and to propose scope, backups, quiescence, rollback and verification before asking to stop or change anything. It preserves native-only, imported, shared and uncertain sessions, and it cannot make a migration safe or complete. Copying files alone leaves the original history listed.

## Interpret provenance

New creation and import requests record their intent in the agent record before the provider session opens, then bind the returned session ID and storage location.

- A request interrupted before registration leaves an unresolved intent. It is hidden from agent and history lists and cannot be opened. Retry with a new request; reusing the reserved ID fails with `HISTORY_INTENT_CONFLICT`, except when the daemon retries the same creation and can prove it never reached the provider.
- `created` means Paseo initiated the session, not that Paseo owns it exclusively: a native client may adopt it later. Imported sessions keep their native IDs and history.
- Treat `needs-classification` as a review requirement. Imported, native-only and conflicting sessions are marked for preservation; a shared working directory or a provider origin label does not prove a session can be removed.

## Limits

- Path checks are bounded and do not lock writers; a later filesystem change can invalidate them. For Codex, a home past the bound (10,000 entries, or a deeper tree than the check walks) is refused. For Claude, only a tree deeper than the check walks is refused.
- Native clients pointed at the same configured home can still list its chats. Native app visibility, end-to-end provider resume and native list refresh are not qualified.
- The preview does not exclude live writers. It copies SQLite files before reading them, needs `node:sqlite` (Node 22.13+ or 24), and reports a changed snapshot instead of retrying. Malformed metadata, scan limits, files over 128 MiB and unsupported schemas appear as issue codes; an incomplete inventory is not an empty one.
- Claude inventory needs a recognized `sessionId` in each transcript's first record.
