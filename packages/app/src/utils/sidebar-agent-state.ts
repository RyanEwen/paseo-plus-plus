import {
  deriveAgentStateBucket,
  type AgentAttentionReason,
  type AgentStateBucketInput,
} from "@getpaseo/protocol/agent-state-bucket";

export type SidebarStateBucket = "needs_input" | "failed" | "running" | "attention" | "done";
export type SidebarAttentionReason = AgentAttentionReason;

export function deriveSidebarStateBucket(input: AgentStateBucketInput): SidebarStateBucket {
  return deriveAgentStateBucket(input);
}

export function isSidebarActiveAgent(input: AgentStateBucketInput): boolean {
  return deriveSidebarStateBucket(input) !== "done";
}

/**
 * Shared urgency order for status groups and project summaries. Actionable work stays visible
 * ahead of running work even when a collapsed project hides its workspace rows.
 */
export const STATUS_BUCKET_ORDER: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "attention",
  "running",
  "done",
] as const;

/**
 * Collapses many workspace status buckets into the single most urgent one, so a
 * collapsed project row can stand in for the child rows it hides.
 */
export function aggregateSidebarStateBuckets(
  buckets: Iterable<SidebarStateBucket>,
): SidebarStateBucket {
  let bestRank = STATUS_BUCKET_ORDER.length - 1;
  for (const bucket of buckets) {
    const rank = STATUS_BUCKET_ORDER.indexOf(bucket);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
    }
  }
  return STATUS_BUCKET_ORDER[bestRank] ?? "done";
}

/** Compare status timestamps newest first, placing unknown times last and preserving ties. */
export function compareSidebarStatusRecency(a: Date | null, b: Date | null): number {
  const aTime = a?.getTime() ?? null;
  const bTime = b?.getTime() ?? null;
  if (aTime !== null && bTime !== null) {
    return bTime - aTime;
  }
  if (aTime !== null) return -1;
  if (bTime !== null) return 1;
  return 0;
}

/** Summarize known children without presenting empty or partly unavailable projects as done. */
export function aggregateKnownSidebarStateBuckets(
  buckets: Iterable<SidebarStateBucket | null>,
): SidebarStateBucket | null {
  const known: SidebarStateBucket[] = [];
  let hasUnknown = false;
  for (const bucket of buckets) {
    if (bucket === null) {
      hasUnknown = true;
    } else {
      known.push(bucket);
    }
  }
  if (known.length === 0) {
    return null;
  }
  const aggregate = aggregateSidebarStateBuckets(known);
  if (aggregate === "done" && hasUnknown) {
    return null;
  }
  return aggregate;
}
