import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { useLoadOlderAgentHistory } from "@/hooks/use-load-older-agent-history";
import { useSessionStore, type AgentTimelineCursorState } from "@/stores/session-store";
import {
  mergeRetainedPrompts,
  retainedCanonicalPositions,
  type CanonicalPromptContexts,
} from "@/timeline/canonical-prompt-context";
import type { CanonicalTimelineCoverage } from "@/timeline/canonical-prompt-model";
import { canonicalCoverageForCursor } from "@/timeline/canonical-reading-source";
import type { CanonicalSourceMetadata } from "@/timeline/canonical-source-metadata";
import type { TimelinePageAcceptance } from "@/timeline/fetch-viewed-timeline-page";
import { useCanonicalPromptContext } from "@/timeline/use-canonical-prompt-context";
import type { StreamItem } from "@/types/stream";
import type { ContextPageReader } from "@/timeline/read-canonical-prompt-context";
import {
  normalContextPageReader,
  normalContextPromptIndexReader,
} from "./fetch-reading-prompt-context";
import type { createPromptReadingPublisher } from "./prompt-reading-position";
import { resolveRetainedContextSource } from "./sticky-prompt-model";

/** History a child transcript supplies instead of the root chat's viewed timeline. The
 * prompt-context fields keep retained prompts inside that child's own history owner. */
export interface TranscriptHistoryPagination {
  /** Authoritative epoch for a transcript with its own history owner. */
  epoch?: string | null;
  hasOlder: boolean;
  isLoadingOlder: boolean;
  progressKey: string | null;
  readPromptContext?: ContextPageReader;
  promptContexts?: CanonicalPromptContexts;
  coverage?: readonly CanonicalTimelineCoverage[];
  sourceMetadata?: readonly CanonicalSourceMetadata[];
  onLoadOlder: (acceptance?: TimelinePageAcceptance) => boolean | Promise<boolean>;
}

export function useTranscriptCursor(input: {
  serverId: string;
  agentId: string;
  historyPagination: TranscriptHistoryPagination | undefined;
}) {
  const rootTimelineCursor = useSessionStore((state) =>
    state.sessions[input.serverId]?.agentTimelineCursor.get(input.agentId),
  );
  const rootTimelineEpoch = rootTimelineCursor?.epoch ?? null;
  const timelineEpoch = resolveTranscriptEpoch(input.historyPagination, rootTimelineEpoch);
  return { rootTimelineCursor, timelineEpoch };
}

interface RetainedCanonicalTranscriptInput {
  resolvedServerId: string;
  agentId: string;
  timelineEpoch: string | null;
  historyPagination: TranscriptHistoryPagination | undefined;
  rootTimelineCursor: AgentTimelineCursorState | undefined;
  client: DaemonClient | null;
  promptReading: ReturnType<typeof createPromptReadingPublisher>;
  effectiveStreamItems: StreamItem[];
  effectiveStreamHead: StreamItem[] | undefined;
  stickyEnabled: boolean;
  canIndexPrompts: boolean;
  isActive: boolean;
  isAuthoritativeHistoryReady: boolean;
}

/** Admit canonical sources before the single presentation pass, without extending window coverage. */
export function useRetainedCanonicalTranscript({
  resolvedServerId,
  agentId,
  timelineEpoch,
  historyPagination,
  rootTimelineCursor,
  client,
  promptReading,
  effectiveStreamItems,
  effectiveStreamHead,
  stickyEnabled,
  canIndexPrompts,
  isActive,
  isAuthoritativeHistoryReady,
}: RetainedCanonicalTranscriptInput) {
  const timelineOwner = useSessionStore(
    (state) => state.sessions[resolvedServerId]?.viewedTimelineSync ?? null,
  );
  const rootContextOwner = timelineOwner?.promptContexts ?? null;
  const contextOwner = historyPagination
    ? (historyPagination.promptContexts ?? null)
    : rootContextOwner;
  const childTranscript = historyPagination !== undefined;
  const suppliedCoverage = historyPagination?.coverage;
  const contextCoverage = useMemo(() => {
    if (childTranscript) return suppliedCoverage ?? [];
    return canonicalCoverageForCursor(rootTimelineCursor);
  }, [childTranscript, suppliedCoverage, rootTimelineCursor]);
  const sourceItems = useMemo(
    () => [...effectiveStreamItems, ...(effectiveStreamHead ?? [])],
    [effectiveStreamItems, effectiveStreamHead],
  );
  const readSource = useCallback(() => {
    return resolveRetainedContextSource(
      sourceItems,
      timelineEpoch,
      promptReading.getSnapshot(),
      contextCoverage,
    );
  }, [promptReading, sourceItems, timelineEpoch, contextCoverage]);
  const contextSource = useSyncExternalStore(promptReading.subscribe, readSource, readSource);
  const suppliedContextReader = historyPagination?.readPromptContext;
  const contextReader = useMemo(() => {
    if (childTranscript) return suppliedContextReader;
    if (client) return normalContextPageReader(client, agentId);
    return undefined;
  }, [childTranscript, suppliedContextReader, client, agentId]);
  const contextLookup = useMemo(
    () =>
      contextReader
        ? {
            agentId,
            readPage: contextReader,
            readPromptIndex:
              !childTranscript && canIndexPrompts && client
                ? normalContextPromptIndexReader(client, agentId)
                : undefined,
            projection: childTranscript ? ("projected" as const) : ("canonical" as const),
          }
        : undefined,
    [contextReader, childTranscript, agentId, canIndexPrompts, client],
  );
  const retainedContext = useCanonicalPromptContext({
    owner: contextOwner,
    agentId,
    epoch: timelineEpoch,
    source: contextSource,
    ordinaryItems: sourceItems,
    coverage: contextCoverage,
    sourceMetadata: historyPagination?.sourceMetadata,
    enabled: stickyEnabled && isActive,
    lookupReady: isAuthoritativeHistoryReady,
    lookup: contextLookup,
  });
  const canonicalTail = useMemo(
    () =>
      mergeRetainedPrompts(
        effectiveStreamItems,
        retainedContext.contexts,
        effectiveStreamHead ?? [],
      ),
    [effectiveStreamItems, effectiveStreamHead, retainedContext.contexts],
  );
  const retainedPositions = useMemo(
    () => retainedCanonicalPositions(canonicalTail, retainedContext.contexts),
    [canonicalTail, retainedContext.contexts],
  );
  const contextOnlyIds = useMemo(
    () =>
      new Set(
        mergeRetainedPrompts([], retainedContext.contexts, sourceItems).map((item) => item.id),
      ),
    [retainedContext.contexts, sourceItems],
  );

  return { sourceItems, retainedContext, canonicalTail, retainedPositions, contextOnlyIds };
}

/** Child transcripts supply their own page owner; root chats use the viewed timeline. */
export function resolveHistoryPagination(
  provided: TranscriptHistoryPagination | undefined,
  root: ReturnType<typeof useLoadOlderAgentHistory>,
): ReturnType<typeof useLoadOlderAgentHistory> {
  if (!provided) return root;
  return {
    isLoadingOlder: provided.isLoadingOlder,
    hasOlder: provided.hasOlder,
    progressKey: provided.progressKey,
    loadOlder: async (acceptance) => provided.onLoadOlder(acceptance),
  };
}

/** A child epoch must not inherit the parent conversation's identity. */
function resolveTranscriptEpoch(
  provided: TranscriptHistoryPagination | undefined,
  rootEpoch: string | null,
): string | null {
  if (provided) return provided.epoch ?? null;
  return rootEpoch;
}

/** An unavailable child cache reader must never fall through to the synthetic parent journal. */
export function resolveContextPageReader(provided: TranscriptHistoryPagination | undefined) {
  if (!provided) return undefined;
  return provided.readPromptContext ?? null;
}

/** Prompt-context inputs a memoized stream view must not hold stale. */
export function historyContextPropsEqual(
  left: TranscriptHistoryPagination | undefined,
  right: TranscriptHistoryPagination | undefined,
): boolean {
  return (
    left?.readPromptContext === right?.readPromptContext &&
    left?.promptContexts === right?.promptContexts &&
    left?.coverage === right?.coverage &&
    left?.sourceMetadata === right?.sourceMetadata
  );
}
