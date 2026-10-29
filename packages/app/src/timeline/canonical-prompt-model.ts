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
