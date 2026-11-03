import {
  EMPTY_SOURCE_METADATA,
  resolveCanonicalSourceMetadata,
  type CanonicalSourceMetadata,
} from "./canonical-source-metadata";
import {
  planCanonicalReadingAttempt,
  coversCanonicalInterval,
  type CanonicalReadingAttempt,
} from "./canonical-reading-source";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem } from "@/types/stream";
import {
  canonicalPromptSourceKey,
  retainCanonicalPromptContext,
  CanonicalPromptContextBudgetError,
  type CanonicalPromptContexts,
  type CanonicalPromptLookup,
  type CanonicalPromptContext,
  type CanonicalTimelineCoverage,
} from "./canonical-prompt-context";
const EMPTY: readonly CanonicalPromptContext[] = Object.freeze([]);
const noopSubscribe = () => () => {};
interface CanonicalPromptContextState {
  scope: object;
  key: string | null;
  loading: boolean;
  error: boolean;
  limited: boolean;
  exhausted: boolean;
}

interface CanonicalPromptContextInput {
  owner: CanonicalPromptContexts | null;
  agentId: string;
  epoch: string | null;
  source: StreamItem | undefined;
  enabled: boolean;
  /** Accepted history admits remote reads; pending authority keeps local preview and leases. */
  lookupReady?: boolean;
  ordinaryItems?: readonly StreamItem[];
  coverage?: readonly CanonicalTimelineCoverage[];
  sourceMetadata?: readonly CanonicalSourceMetadata[];
  lookup: CanonicalPromptLookup | undefined;
}

interface CanonicalPromptPreviewInput {
  input: CanonicalPromptContextInput;
  plan: CanonicalReadingAttempt;
  source: StreamItem | undefined;
  metadata: readonly CanonicalSourceMetadata[];
  suppressed: boolean;
}

function resolveCanonicalPromptPreview({
  input,
  plan,
  source,
  metadata,
  suppressed,
}: CanonicalPromptPreviewInput): CanonicalPromptContext | undefined {
  if (
    !input.owner ||
    !input.enabled ||
    !source ||
    source.timelineCursor?.epoch !== input.epoch ||
    suppressed
  )
    return undefined;
  if (plan.blocked && !hasCoveredCurrentOccurrence(source, metadata, input.coverage ?? []))
    return undefined;
  return input.owner.preview(input.agentId, source);
}

/** One transcript requests its current canonical source. Admission belongs to the
 * timeline owner; changing response text cannot restart a held occurrence read.
 */
export function useCanonicalPromptContext(input: CanonicalPromptContextInput) {
  const lookupReady = input.lookupReady ?? true;
  const channel = useMemo(
    () => ({ owner: input.owner, agentId: input.agentId, epoch: input.epoch }),
    [input.owner, input.agentId, input.epoch],
  );
  const requestScope = useMemo(
    // Admission phases retire attempts without replacing the channel's retained lease.
    () => ({ channel, enabled: input.enabled, lookupReady }),
    [channel, input.enabled, lookupReady],
  );
  const contexts = useSyncExternalStore(
    input.owner?.subscribe ?? noopSubscribe,
    () => input.owner?.read(input.agentId, input.epoch, channel) ?? EMPTY,
    () => EMPTY,
  );
  useSyncExternalStore(
    input.owner?.subscribe ?? noopSubscribe,
    () => input.owner?.readRevision(input.agentId, input.epoch) ?? EMPTY,
    () => EMPTY,
  );
  const ownerMetadata = useSyncExternalStore(
    input.owner?.subscribe ?? noopSubscribe,
    () => input.owner?.readSourceMetadata(input.agentId, input.epoch) ?? EMPTY_SOURCE_METADATA,
    () => EMPTY_SOURCE_METADATA,
  );
  const metadata = input.sourceMetadata ?? ownerMetadata;
  const [attempt, setAttempt] = useState(0);
  const previousAttempt = useRef<{ scope: object; plan: CanonicalReadingAttempt } | null>(null);
  const previous =
    lookupReady && previousAttempt.current?.scope === requestScope
      ? previousAttempt.current.plan
      : undefined;
  const plan = planCanonicalReadingAttempt(
    previous,
    input.source,
    input.ordinaryItems ?? [],
    input.coverage ?? [],
    attempt,
  );
  const source = plan.blocked ? plan.latest : currentCanonicalReadingSource(plan);
  const sourceKey = source ? canonicalPromptSourceKey(source) : null;
  useLayoutEffect(() => {
    // Painted, unaccepted cursor advances cannot establish a remote attempt baseline.
    previousAttempt.current = lookupReady ? { scope: requestScope, plan } : null;
  });
  const suppressed = useRef<{ scope: object; key: string | null } | null>(null);
  const isSuppressed =
    suppressed.current?.scope === requestScope && suppressed.current.key === sourceKey;
  const known = resolveCanonicalPromptPreview({
    input,
    plan,
    source,
    metadata,
    suppressed: isSuppressed,
  });
  // A newly certified local result retires a held miss before passive effects.
  // Semantic identity avoids restarting work on every owner publication.
  const knownKey = known
    ? JSON.stringify([
        known.sourceKey,
        known.sourceStart,
        known.prompt.id,
        known.prompt.timelineCursor,
      ])
    : null;
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<CanonicalPromptContextState>({
    scope: requestScope,
    key: null,
    loading: false,
    error: false,
    limited: false,
    exhausted: false,
  });
  const currentSource = useStableEvent(() => source);
  const currentKnown = useStableEvent(() => known);
  // Retire acceptance at commit, before passive cleanup or a held completion can
  // publish into an owner/source that this pane has already left.
  useLayoutEffect(
    () => () => {
      active.current?.abort();
      input.owner?.cancel(channel);
    },
    [
      input.owner,
      channel,
      requestScope,
      sourceKey,
      knownKey,
      plan.blocked,
      input.lookup,
      lookupReady,
    ],
  );
  useLayoutEffect(() => () => input.owner?.release(channel), [input.owner, channel]);
  useEffect(() => {
    const owner = input.owner;
    const requestedSource = currentSource();
    const local = currentKnown();
    if (
      !input.enabled ||
      !lookupReady ||
      (plan.blocked && !local) ||
      !requestedSource ||
      requestedSource.kind === "user_message" ||
      !sourceKey ||
      (suppressed.current?.scope === requestScope && suppressed.current.key === sourceKey)
    )
      return;
    if (!owner) {
      setState({
        scope: requestScope,
        key: sourceKey,
        loading: false,
        error: true,
        limited: false,
        exhausted: false,
      });
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setState({
      scope: requestScope,
      key: sourceKey,
      loading: !local,
      error: false,
      limited: false,
      exhausted: false,
    });
    void owner
      .request({
        agentId: input.agentId,
        source: requestedSource,
        channel,
        signal: controller.signal,
        lookup: input.lookup,
        lookupAllowed: !plan.blocked,
        retryToken: attempt,
      })
      .then(
        (prompt) => {
          if (!controller.signal.aborted)
            setState({
              scope: requestScope,
              key: sourceKey,
              loading: false,
              error: false,
              limited: false,
              exhausted: prompt === undefined,
            });
          return null;
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({
              scope: requestScope,
              key: sourceKey,
              loading: false,
              error: !(error instanceof CanonicalPromptContextBudgetError),
              limited: error instanceof CanonicalPromptContextBudgetError,
              exhausted: false,
            });
          return null;
        },
      );
    return () => {
      controller.abort();
      owner.cancel(channel);
      if (active.current === controller) active.current = null;
    };
  }, [
    input.enabled,
    lookupReady,
    input.owner,
    input.agentId,
    input.epoch,
    sourceKey,
    knownKey,
    plan.blocked,
    input.lookup,
    channel,
    requestScope,
    attempt,
    currentSource,
    currentKnown,
  ]);
  const cancel = useStableEvent(() => {
    active.current?.abort();
    input.owner?.cancel(channel);
    suppressed.current = { scope: requestScope, key: sourceKey };
    setState({
      scope: requestScope,
      key: sourceKey,
      loading: false,
      error: false,
      limited: false,
      exhausted: false,
    });
  });
  const retry = useStableEvent(() => {
    suppressed.current = null;
    setAttempt((value) => value + 1);
  });
  const visibleContexts = useMemo(
    () => (known ? retainCanonicalPromptContext(contexts, known) : contexts),
    [contexts, known],
  );
  const status = resolveCanonicalContextStatus(
    input,
    requestScope,
    sourceKey,
    plan,
    state,
    suppressed.current,
  );
  return {
    contexts: visibleContexts,
    // Leases support reuse/navigation; only this existing preview is certified
    // for the current attempt's source, scope and cancellation state.
    currentContext: known,
    ...status,
    ...(known ? { loading: false, error: false, limited: false, exhausted: false } : {}),
    cancel,
    retry,
  };
}

function resolveCanonicalContextStatus(
  input: CanonicalPromptContextInput,
  requestScope: object,
  sourceKey: string | null,
  plan: CanonicalReadingAttempt,
  state: CanonicalPromptContextState,
  suppressed: { scope: object; key: string | null } | null,
) {
  const lookupReady = input.lookupReady ?? true;
  const current =
    state.scope === requestScope && state.key === sourceKey && input.enabled && lookupReady;
  return {
    loading: current && !plan.blocked && state.loading,
    error: (input.enabled && lookupReady && plan.blocked) || (current && state.error),
    exhausted: current && state.exhausted,
    limited: current && state.limited,
    cancelled:
      input.enabled &&
      sourceKey !== null &&
      suppressed?.scope === requestScope &&
      suppressed.key === sourceKey,
  };
}

function currentCanonicalReadingSource(plan: CanonicalReadingAttempt): StreamItem | undefined {
  if (
    plan.latest &&
    plan.anchor &&
    canonicalPromptSourceKey(plan.latest) === canonicalPromptSourceKey(plan.anchor)
  )
    return plan.latest;
  return plan.anchor;
}

function hasCoveredCurrentOccurrence(
  source: StreamItem,
  metadata: readonly CanonicalSourceMetadata[],
  coverage: readonly CanonicalTimelineCoverage[],
): boolean {
  const descriptor = resolveCanonicalSourceMetadata(metadata, source);
  const cursor = source.timelineCursor;
  return (
    !!descriptor &&
    !!cursor &&
    coversCanonicalInterval(coverage, cursor.epoch, descriptor.startSeq, cursor.seq)
  );
}
