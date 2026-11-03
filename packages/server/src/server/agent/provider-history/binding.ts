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

export class HistoryStorageConflictError extends Error {
  readonly code = "HISTORY_STORAGE_CONFLICT";
  constructor(readonly reason: string) {
    super(`Configured provider history cannot use this route: ${reason}`);
    this.name = "HistoryStorageConflictError";
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
