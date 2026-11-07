import { createHash } from "node:crypto";
import { z } from "zod";

export const ProviderHistoryStorageSchema = z.union([
  z.object({ kind: z.literal("unknown") }),
  z.object({
    kind: z.literal("unverified"),
    provider: z.enum(["codex", "claude"]),
    home: z.string().min(1),
    // Configuration can redirect SQLite independently of CODEX_HOME. Absence is unresolved.
    sqliteHome: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("configured-home"),
    provider: z.literal("codex"),
    home: z.string().min(1),
    sqliteHome: z.string().min(1),
  }),
  z
    .object({
      kind: z.literal("configured-home"),
      provider: z.literal("claude"),
      // Preserve the exact configured selector; Claude normalizes its filesystem path to NFC.
      home: z.string().min(1),
    })
    .strict(),
]);

export const ProviderHistoryBindingSchema = z.object({
  // Initiation is not exclusive ownership: a native client can later adopt the same session.
  origin: z.enum(["created", "imported", "legacy"]),
  registration: z.enum(["intent", "registered"]),
  sessionId: z.string().min(1).nullable(),
  storage: ProviderHistoryStorageSchema,
});

export type ProviderHistoryStorage = z.infer<typeof ProviderHistoryStorageSchema>;
export type ProviderHistoryBinding = z.infer<typeof ProviderHistoryBindingSchema>;
export type ConfiguredHistoryStorage = Extract<
  ProviderHistoryStorage,
  { kind: "configured-home"; provider: "codex" }
>;
export type ConfiguredClaudeHistoryStorage = Extract<
  ProviderHistoryStorage,
  { kind: "configured-home"; provider: "claude" }
>;

export function sameHistoryStorage(
  left: ProviderHistoryStorage,
  right: ProviderHistoryStorage,
): boolean {
  if (left.kind === "unknown" || right.kind === "unknown") return left.kind === right.kind;
  return (
    left.kind === right.kind &&
    left.provider === right.provider &&
    left.home === right.home &&
    ("sqliteHome" in left ? left.sqliteHome : undefined) ===
      ("sqliteHome" in right ? right.sqliteHome : undefined)
  );
}

/** Why a configured history route, binding or identity transition was refused. */
export type HistoryConflictReason =
  | "bound-native-handle-conflict"
  | "bound-provider-conflict"
  | "bound-session-handle-missing"
  | "bound-session-id-changed"
  | "bound-storage-changed"
  | "command-sqlite-selector-conflict"
  | "committed-identity-reload-required"
  | "configured-history-cli-version-unsupported"
  | "configured-root-must-already-exist"
  | "destination-config-missing-or-linked"
  | "destination-config-not-ordinary"
  | "destination-family-unsupported"
  | "destination-history-not-configured"
  | "destination-must-be-configured-codex-profile"
  | "destination-provider-disabled"
  | "durable-initial-binding-required"
  | "durable-storage-required"
  | "empty-creation-registration-conflict"
  | "environment-sqlite-selector-conflict"
  | "existing-route-unverified"
  | "explicit-profile-home-required"
  | "explicit-profile-sqlite-home-required"
  | "fresh-admission-conflict-reload-required"
  | "fresh-query-admission-conflict"
  | "fresh-rewind-handle-conflict"
  | "fresh-rewind-record-conflict"
  | "history-admission-record-missing"
  | "history-hardlink"
  | "history-identity-write-refused"
  | "history-path-check-limit"
  | "history-special-file"
  | "history-symlink"
  | "identity-acknowledgment-limit"
  | "initial-admission-conflict-reload-required"
  | "initial-handle-binding-conflict"
  | "initial-handle-binding-required"
  | "initial-query-admission-conflict"
  | "intent-storage-already-bound"
  | "invalid-session-id"
  | "known-native-history-root"
  | "launch-home-conflict"
  | "launch-home-unresolved"
  | "launch-sqlite-home-unresolved"
  | "managed-rewind-required"
  | "provider-storage-observation-conflict"
  | "query-admission-identity-changed"
  | "request-sqlite-home-unresolved"
  | "request-sqlite-selector-conflict"
  | "retired-rewind-session"
  | "rewind-canonical-handle-conflict"
  | "rewind-canonical-record-changed"
  | "rewind-committed-adoption-failed"
  | "rewind-handle-conflict"
  | "rewind-intent-conflict"
  | "rewind-record-missing"
  | "rewind-session-not-ready"
  | "rewind-transcript-missing"
  | "rewind-transcript-outside-home"
  | "session-switch-command-use-managed-rewind"
  | "snapshot-intent-id-changed"
  | "snapshot-origin-changed"
  | "snapshot-registration-regressed"
  | "snapshot-registration-without-handle"
  | "snapshot-storage-changed"
  | "sqlite-home-requires-configured-history"
  | "stale-fresh-rewind-callback"
  | "stale-fresh-rewind-query"
  | "stale-history-query"
  | "stale-initial-history-callback"
  | "stale-initial-history-query"
  | "stale-rewind-callback"
  | "unexpected-session-id-change"
  | "unresolved-command-config-key"
  | "unresolved-command-config-selector"
  | "unresolved-command-contract"
  | "unresolved-command-selectors"
  | "unresolved-command-sqlite-selector"
  | "unresolved-command-storage-selector"
  | "unresolved-native-profile-selector"
  | "unsupported-project-namespace"
  | "unsupported-provider";

function historyConflictMessage(reason: HistoryConflictReason, detail: string | undefined): string {
  const suffix = detail === undefined ? "" : `:${detail}`;
  return `Configured provider history cannot use this route: ${reason}${suffix}`;
}

/** A configured history route, binding or identity transition was refused; `reason` says which. */
export class HistoryStorageConflictError extends Error {
  readonly code = "HISTORY_STORAGE_CONFLICT";
  constructor(
    readonly reason: HistoryConflictReason,
    /** Optional data appended to the message after the reason, separated by a colon. */
    readonly detail?: string,
  ) {
    super(historyConflictMessage(reason, detail));
    this.name = "HistoryStorageConflictError";
  }

  /** The reason as reported in wrapped failure messages, with its detail when present. */
  describe(): string {
    return this.detail === undefined ? this.reason : `${this.reason}:${this.detail}`;
  }
}

/** Throw the typed refusal for a configured history check. */
export function throwHistoryConflict(reason: HistoryConflictReason): never {
  throw new HistoryStorageConflictError(reason);
}

/**
 * The provider identity transition is already durable, but adopting it into the live session
 * failed. Recovery must reopen the chat from canonical storage at `committedSessionId`.
 */
export class HistoryIdentityCommittedError extends HistoryStorageConflictError {
  constructor(readonly committedSessionId: string | undefined) {
    super("rewind-committed-adoption-failed", String(committedSessionId));
  }
}

export function assertConfiguredHistoryIdentity(
  binding: ProviderHistoryBinding | undefined,
  handle: { sessionId: string; nativeHandle?: unknown } | null | undefined,
): void {
  if (binding?.storage.kind !== "configured-home") return;
  if (!handle) {
    if (binding.registration === "registered" && binding.sessionId)
      throw new HistoryStorageConflictError("bound-session-handle-missing");
    return;
  }
  if (binding.sessionId && binding.sessionId !== handle.sessionId)
    throw new HistoryStorageConflictError("bound-session-id-changed");
  if (handle.nativeHandle && handle.nativeHandle !== handle.sessionId)
    throw new HistoryStorageConflictError("bound-native-handle-conflict");
}

function validateConfiguredSnapshotBinding(
  existing: ProviderHistoryBinding,
  incoming: ProviderHistoryBinding,
  handle: { sessionId: string; nativeHandle?: unknown } | null | undefined,
): void {
  if (!sameHistoryStorage(incoming.storage, existing.storage))
    throw new HistoryStorageConflictError("snapshot-storage-changed");
  if (incoming.origin !== existing.origin)
    throw new HistoryStorageConflictError("snapshot-origin-changed");
  if (existing.registration === "registered" && incoming.registration !== "registered")
    throw new HistoryStorageConflictError("snapshot-registration-regressed");
  if (incoming.sessionId !== null)
    assertConfiguredHistoryIdentity(existing, { sessionId: incoming.sessionId });
  if (handle) assertConfiguredHistoryIdentity(incoming, handle);
}

export function preserveSnapshotHistoryBinding(
  existing: ProviderHistoryBinding | undefined,
  incoming: ProviderHistoryBinding | undefined,
  handle: { sessionId: string; nativeHandle?: unknown } | null | undefined,
): ProviderHistoryBinding | undefined {
  if (existing?.storage.kind !== "configured-home") return incoming ?? existing;
  assertConfiguredHistoryIdentity(existing, handle);
  if (existing.storage.provider === "claude" && existing.sessionId === null && handle)
    throw new HistoryStorageConflictError("initial-handle-binding-required");
  // Older adapters do not own this metadata. A configured observation must pass all
  // canonical identity/provenance checks before it can advance registration.
  if (incoming?.storage.kind !== "configured-home") return existing;
  validateConfiguredSnapshotBinding(existing, incoming, handle);
  if (existing.registration === "registered") return existing;
  if (incoming.registration === "intent") {
    if (incoming.sessionId !== existing.sessionId)
      throw new HistoryStorageConflictError("snapshot-intent-id-changed");
    return existing;
  }
  if (!handle) throw new HistoryStorageConflictError("snapshot-registration-without-handle");
  // The first thread can be observed after the initial registration snapshot was
  // assembled. Only its actual handle supplies the canonical ID, never an incoming tag.
  return { ...existing, registration: "registered", sessionId: handle.sessionId };
}

interface HistoryObservation {
  binding: ProviderHistoryBinding | undefined;
  sessionId: string | null;
  storage?: ProviderHistoryStorage;
}

export function registerProviderHistory(
  input: HistoryObservation,
): ProviderHistoryBinding | undefined {
  const { binding, sessionId, storage } = input;
  if (!binding) return undefined;
  if (binding.storage.kind === "configured-home") {
    if (binding.sessionId && sessionId && binding.sessionId !== sessionId)
      throw new HistoryStorageConflictError("bound-session-id-changed");
    if (storage && !sameHistoryStorage(storage, binding.storage))
      throw new HistoryStorageConflictError("provider-storage-observation-conflict");
  }
  const observedStorage = storage ?? binding.storage;
  const selectedStorage = binding.storage.kind === "unknown" ? observedStorage : binding.storage;
  return {
    ...binding,
    registration: "registered",
    sessionId: binding.sessionId ?? sessionId,
    storage: selectedStorage,
  };
}

export class HistoryIntentConflictError extends Error {
  readonly code = "HISTORY_INTENT_CONFLICT";
  constructor(readonly agentId: string) {
    super(`Agent ${agentId} already has durable state; history intent was not reserved`);
    this.name = "HistoryIntentConflictError";
  }
}

/** SHA-256 of a value's JSON form, for exact record comparisons inside the write queue. */
export function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
