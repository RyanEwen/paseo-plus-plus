# Provider history safety, preview and migration guidance

Use a fully provisioned Codex or Claude profile to bind new Paseo chats to its selected storage.
Inspect existing history read-only, then copy migration guidance to an agent for review. Paseo
has no built-in migration apply or recovery command. A configured profile does not move chats
or prove that a native app cannot list them.

## Bind a configured Codex profile

Opt in on the exact provider entry in `$PASEO_HOME/config.json`. The directories must already
exist and contain the account/config context your installed Codex needs. Paseo does not create
a home, copy credentials, sign in or synchronize integrations.

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

Use your existing working profile and its official login/config lifecycle. Auth/config/plugin
links remain under your control. Choose history and database roots separate from native storage;
a private-looking directory name does not establish privacy. `sqlite_home` is Codex's native
startup option. The guard requires it explicitly because config-file and environment selectors
have different precedence. It is never sent as a per-thread setting.

Configured startup currently admits the trusted native `codex-cli 0.166.0` contract. Other
versions, replace-command wrappers, unresolved native profiles and known selector conflicts
fail before app-server startup. The version check is not executable attestation. Shared/default
profiles keep their existing launch behavior; `history` is optional and `mode: "shared"` opts out
for new requests (remove the startup-only SQLite option from an unbound shared profile).
Claude has a separate configured-home route below. Other providers do not implement this admission.

Paseo persists the exact home and SQLite binding before launching a new create/import request.
Resume, reload and native archive/restore compare that binding before opening app-server. A
changed profile reports `HISTORY_STORAGE_CONFLICT`; restore the recorded settings to resume.
Reload checks the route before closing the current session. Native archive remains best effort;
failed native restore leaves the Paseo record archived. Discovery/probes use the selected profile
route without creating an ordinary agent record.

Existing native/imported/legacy sessions are not moved or rebound by enabling the policy. An
existing unverified route reports `existing-route-unverified` before resume instead of adopting
new roots. Use its original shared profile/settings until its route can be classified. Legacy
startup retries without a provider handle retain unknown provenance; a configured policy cannot
silently upgrade them. New imports from a configured profile retain their native IDs and imported
provenance. Imported provider-managed children do not acquire creation provenance. A child without a known
configured storage binding cannot resume through the guarded route; descendant inheritance
still needs provider qualification.

The guard rejects known native default roots and linked history/database paths, including regular
files with multiple hardlinks. Auth/config links are outside that check. Path checks are bounded,
require ordinary ancestors and do not lock writers; a later filesystem change or unknown managed
provider policy remains a limitation. A native client deliberately opening the same configured
home may still list its chats. Native App visibility needs separate qualification.

## Bind a configured Claude profile

Use an existing working profile, with its official account/config lifecycle already provisioned:

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

Paseo preserves the exact `CLAUDE_CONFIG_DIR` spelling and any secure-storage selector. It does
not create or populate that home, access/copy credentials or Keychain entries, sign in, or sync
settings/plugins/MCP resources. Claude's filesystem path uses NFC normalization. Its native
command route must honor this environment; fixtures check Paseo's pinned SDK routing, without
qualifying an installed CLI/account/platform or native App visibility. Native clients pointed at
the same home can still list its chats. Claude has no SQLite selector.

The guard rejects known native default roots, history links/hardlinks, unsupported project
namespaces, replace wrappers, appended command arguments and nonempty `extraArgs`. History
checks are bounded and do not lock writers. Missing/unresolved routes and changed launch overlays
fail before SDK construction, transcript reads or query startup. Auth/config/integration links
outside history remain under your control. Shared/absent policy keeps the existing route.

Bindings are persisted before create/import and checked on resume/reload. An empty registered chat
can reopen before its first prompt using the same bound route and stored config; a changed request
cannot overwrite it. Existing unverified
or legacy handles cannot adopt the new configured default; restore their original shared profile
until classified. New native imports from the configured home retain imported origin and IDs.
A bound chat stays guarded if the policy is later removed. Unknown children are not adopted.

Use Paseo's managed rewind controls for conversation, files or both. Deliberate conversation rewind
commits the provider's actual new handle in the same home before publishing it, preserving Paseo
identity and initiation origin. A failed fork/CAS retains the old recovery handle and reports any
uncommitted child without deleting it. Combined rewind runs files first; a later conversation
failure can leave files rewound. A post-commit adoption failure reports the committed identity and
requires reopening that chat from canonical storage.

Rewinding to the beginning records a pending fresh-conversation intent and clears the view. The
old handle remains for recovery until the next requested query provides an actual new handle;
restart/reload preserves this intent and does not display the old conversation as a successful
reset. A failed fresh query keeps the intent. No extra prompt/model turn is sent by rewind. Actual handle consumption also requires an ordinary
persisted transcript when the SDK acknowledgment is consumed. A missing file fails without polling;
SDK init/file ordering has not been qualified against a live CLI.
Unexpected hook/SDK identity switches fail. Session-switching slash commands (`/clear`, `/new`,
`/fork`, `/resume`, `/rewind`) report an explicit restriction before dispatch; managed rewind
controls remain available. Native App exclusion still requires separate qualification.

## Preview a migration

Inspect the source without launching a provider:

```sh
paseo provider history preview codex --home /absolute/paseo-home --provider-home /absolute/codex-home --json
paseo provider history preview claude --home /absolute/paseo-home --provider-home /absolute/claude-home --json
```

Pass the exact provider home you intend to inspect. For a custom provider ID, add
`--family codex` or `--family claude`. If Codex stores SQLite separately, pass
`--sqlite-home /absolute/sqlite-home`. The command accepts local homes only and does not
connect to or start a daemon. It does not infer a custom binary's storage settings.

The report lists managed session candidates, native-only sessions, actual Codex parent/fork/spawn
links, missing session files, supporting artifacts and conflicts. It contains paths, identifiers,
sizes and hashes, without prompt or transcript contents. The digest identifies this inventory;
it is not an approval to migrate it.

Every preview report has `applySupported: false`. Preview never moves files or removes history.
Its digest identifies the inventory and grants no permission to mutate it.
Preview does not hide chats from Codex App or other native provider interfaces.

Compare the source with an existing configured Codex destination:

```sh
paseo provider history preview codex --home /absolute/paseo-home --provider-home /absolute/source-codex-home --destination-provider codex-work --json
```

The destination uses the canonical local config and the same profile inheritance/admission rules.
It reports source overlap, colliding session IDs and destination inventory issues. It does not
start a daemon, resolve the installed CLI version, apply launch-time plugin environment or verify
managed provider policy. `admission: "configured"` records path/config checks; inspect all issues
before treating the inventory as complete. Missing homes/config remain missing. Linked config is
not followed.

## Copy migration guidance

In **Provider settings**, open a provider's actions menu and choose **Copy migration prompt**.
The copied prompt identifies that provider and explicitly records `inventoryPerformed: false`.
It has no source/destination paths or candidate IDs. Paste it into an agent yourself; copying
never launches an agent, runs a provider, changes configuration or grants permission to migrate.
The action uses only provider identity; it does not read history, auth or configuration.

For guidance with a local read-only preview, run:

```sh
paseo provider history migration-prompt codex --home /absolute/paseo-home --provider-home /absolute/source-codex-home --sqlite-home /absolute/source-sqlite-home --destination-home /absolute/configured-codex-home --destination-sqlite-home /absolute/configured-sqlite-home
paseo provider history migration-prompt claude --home /absolute/paseo-home --provider-home /absolute/source-claude-home --destination-home /absolute/configured-claude-home
```

Use `--family codex` or `--family claude` for a derived provider ID. The destination is an explicit
proposal, not verified configuration. The command does not create or inspect it. Human output is
copyable text; `--json` includes that text and its allowlisted context. No transcript, title,
credential or arbitrary config/environment value is included. Paths and IDs remain untrusted data.
The context is bounded; inspect its omission counts and issues. A preview is partial evidence,
not approval or proof of exclusive ownership.

The guidance asks your agent to establish the installed backend/version/platform and complete
storage/dependency contract, then propose exact scope, backups, quiescence, rollback and
verification before requesting permission to stop or mutate anything. Native-only, imported,
shared and uncertain sessions remain preserved. Stopping the agent's own host requires a
separately approved independent continuation and recovery path. Unsupported contracts must be
reported rather than guessed. There is no automatic credential bridge or home provisioning.

Have the agent preserve original IDs, provenance and Paseo metadata, verify same-ID resume and
native/Paseo listings, and check the native App where available. Copying files alone leaves the
original history listed. A prompt cannot guarantee that a migration is safe or complete.

## Interpret provenance

New Paseo creation and import requests record their intent in the existing agent record before
opening the provider session. The record later binds the returned session ID and, where the
adapter reports it, a storage location. Configured routes retain their pre-launch binding;
other observations remain unverified. A request interrupted before registration
can retain an unresolved intent. Its original configuration and workspace remain in the audit
record. Preview reports their field names and workspace ID without printing configuration values.

Unresolved intents are excluded from ordinary agent/history queries and cannot be opened as
resumable chats, including after restart. Retry with a new creation or import request to allocate
a new Paseo ID. Reusing the reserved ID fails with `HISTORY_INTENT_CONFLICT`; it does not replace
the audit record or adopt a possible orphaned provider session. Legacy startup failures without
provenance keep their existing retry behavior and remain unclassified.

`created` establishes that Paseo initiated the session. It cannot establish exclusive ownership:
a native client may have adopted the same session afterward. Imported sessions retain their
native IDs and history. Provider-managed children imported into Paseo are not reclassified as
Paseo-created sessions.

Treat `needs-classification` as a review requirement. Imported, native-only and conflicting
sessions are marked for preservation. Neither a shared working directory nor a provider's
source/origin label proves that a session can be removed from native history.

## Limits

The preview does not exclude current native writers. It reports unverified native use and
storage configuration on every run. Symlink paths are reported without traversal. Malformed
metadata, bounded-scan limits and unsupported database schemas appear as issue codes; do not
treat an incomplete inventory as an empty history.

SQLite inspection requires `node:sqlite` enabled in the runtime (Node 22.13+ or Node 24).
An unavailable runtime is reported without inspecting the database. It reads disposable database/WAL
copies so SQLite cannot create locks or shared-memory files in the source home. Missing files
and homes remain missing. A live writer can invalidate the snapshot; the command does not
retry by repairing or locking the source. A changed database/WAL snapshot contributes no ancestry
edges. File-copy checks do not establish an atomic snapshot of a live provider's storage.

Claude inventory requires a recognized `sessionId` in the first transcript record. A leading
queue or summary record without it is reported as unrecognized. Files over 128 MiB and other
scan limits are explicit issues; the report does not claim a complete inventory in those cases.

Paseo has no built-in migration apply route for any provider. End-to-end provider resume,
storage isolation and native App list/cache refresh require
separate qualification. Backend file or database checks do not establish that Codex App has
refreshed its conversation list.
