import type { StreamItem } from "@/types/stream";

type Prompt = Extract<StreamItem, { kind: "user_message" }>;
export interface CanonicalTimelineCoverage {
  epoch: string;
  startSeq: number;
  endSeq: number;
}
export interface CanonicalPromptContext {
  sourceKey: string;
  sourceStart: number;
  sourceEnd: number;
  prompt: Prompt;
}
export interface CanonicalPromptContextProgress {
  sourceKey: string;
  sourceStart: number;
  sourceEnd: number;
  cursor: number;
}
export class CanonicalPromptContextBudgetError extends Error {
  constructor(readonly progress: CanonicalPromptContextProgress) {
    super("Reading context reached its request budget");
  }
}
export function canonicalPromptOccurrenceKey(source: StreamItem): string {
  const turn = "turnId" in source ? (source.turnId ?? null) : null;
  let providerIdentity: string | null = null;
  if (source.kind === "assistant_message") providerIdentity = source.messageId ?? null;
  else if (source.kind === "tool_call" && source.payload.source === "agent")
    providerIdentity = source.payload.data.callId;
  else if (source.kind === "notification") providerIdentity = source.sourceType;
  return JSON.stringify([
    source.timelineCursor?.epoch,
    source.kind,
    source.id,
    turn,
    providerIdentity,
  ]);
}
export function canonicalPromptSourceKey(source: StreamItem): string {
  return JSON.stringify([canonicalPromptOccurrenceKey(source), source.timelineCursor?.seq]);
}

/** Insert or refresh a key as most recent, evicting the oldest entry past `limit`. */
export function retainBounded<K, V>(entries: Map<K, V>, key: K, value: V, limit: number): void {
  entries.delete(key);
  entries.set(key, value);
  if (entries.size > limit) entries.delete(entries.keys().next().value!);
}

/** Ordinary rows or the source changed under a read; retry resolves the current prompt. */
export class CanonicalPromptContextChangedError extends Error {
  constructor() {
    super("Reading context changed; retry to resolve the current prompt");
  }
}
const PROMPT_CONTEXT_UNAVAILABLE = {
  "owner-unavailable": "Prompt context owner unavailable",
  "reader-scope-changed": "Prompt reader scope changed",
  "provenance-changed": "Prompt context provenance changed",
  "lookup-unavailable": "Canonical prompt context has a different owner or is unavailable",
} as const;

/** The owner, its epoch, the reader's scope or the lookup cannot serve this request. */
export class CanonicalPromptContextUnavailableError extends Error {
  constructor(readonly reason: keyof typeof PROMPT_CONTEXT_UNAVAILABLE) {
    super(PROMPT_CONTEXT_UNAVAILABLE[reason]);
  }
}

/** A newer request on the same reader channel superseded this one. */
export class CanonicalPromptContextStaleError extends Error {
  constructor(options?: ErrorOptions) {
    super("Prompt context request is no longer current", options);
  }
}
