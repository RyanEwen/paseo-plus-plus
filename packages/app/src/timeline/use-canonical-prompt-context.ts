import {
  planCanonicalReadingAttempt,
  type CanonicalReadingAttempt,
} from "./canonical-reading-source";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem } from "@/types/stream";
import {
  canonicalPromptSourceKey,
  CanonicalPromptContextBudgetError,
  type CanonicalPromptContextProgress,
  type CanonicalPromptContexts,
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
  ordinaryItems?: readonly StreamItem[];
  coverage?: readonly CanonicalTimelineCoverage[];
  fetchContext(
    source: StreamItem,
    signal: AbortSignal,
    progress?: CanonicalPromptContextProgress,
  ): Promise<CanonicalPromptContext | undefined>;
}

/** One transcript requests its current canonical source. Admission belongs to the
 * timeline owner; changing response text cannot restart a held occurrence read.
 */
export function useCanonicalPromptContext(input: CanonicalPromptContextInput) {
  const channel = useMemo(
    () => ({ owner: input.owner, agentId: input.agentId, epoch: input.epoch }),
    [input.owner, input.agentId, input.epoch],
  );
  const requestScope = useMemo(
    () => ({ channel, enabled: input.enabled }),
    [channel, input.enabled],
  );
  const contexts = useSyncExternalStore(
    input.owner?.subscribe ?? noopSubscribe,
    () => input.owner?.read(input.agentId, input.epoch, channel) ?? EMPTY,
    () => EMPTY,
  );
  const [attempt, setAttempt] = useState(0);
  const previousAttempt = useRef<{ scope: object; plan: CanonicalReadingAttempt } | null>(null);
  const previous =
    previousAttempt.current?.scope === requestScope ? previousAttempt.current.plan : undefined;
  const plan = planCanonicalReadingAttempt(
    previous,
    input.source,
    input.ordinaryItems ?? [],
    input.coverage ?? [],
    attempt,
  );
  const sourceKey = plan.anchor ? canonicalPromptSourceKey(plan.anchor) : null;
  useLayoutEffect(() => {
    previousAttempt.current = { scope: requestScope, plan };
  });
  const suppressed = useRef<{ scope: object; key: string | null } | null>(null);
  const active = useRef<AbortController | null>(null);
  const [state, setState] = useState<CanonicalPromptContextState>({
    scope: requestScope,
    key: null,
    loading: false,
    error: false,
    limited: false,
    exhausted: false,
  });
  const readCurrent = useStableEvent(
    (source: StreamItem, signal: AbortSignal, progress?: CanonicalPromptContextProgress) =>
      input.fetchContext(source, signal, progress),
  );
  const currentSource = useStableEvent(() => plan.anchor);
  // Retire acceptance at commit, before passive cleanup or a held completion can
  // publish into an owner/source that this pane has already left.
  useLayoutEffect(
    () => () => {
      active.current?.abort();
      input.owner?.cancel(channel);
    },
    [input.owner, channel, requestScope, sourceKey, plan.blocked, input.fetchContext],
  );
  useLayoutEffect(() => () => input.owner?.release(channel), [input.owner, channel]);
  useEffect(() => {
    const owner = input.owner;
    const source = currentSource();
    if (
      !input.enabled ||
      plan.blocked ||
      !source ||
      source.kind === "user_message" ||
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
      loading: true,
      error: false,
      limited: false,
      exhausted: false,
    });
    void owner
      .request({
        agentId: input.agentId,
        source,
        channel,
        signal: controller.signal,
        fetchContext: readCurrent,
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
              exhausted: !prompt,
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
    input.owner,
    input.agentId,
    input.epoch,
    sourceKey,
    plan.blocked,
    input.fetchContext,
    channel,
    requestScope,
    attempt,
    currentSource,
    readCurrent,
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
  return {
    contexts,
    ...resolveCanonicalContextStatus(
      input,
      requestScope,
      sourceKey,
      plan,
      state,
      suppressed.current,
    ),
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
  const current = state.scope === requestScope && state.key === sourceKey && input.enabled;
  return {
    loading: current && !plan.blocked && state.loading,
    error: (input.enabled && plan.blocked) || (current && state.error),
    exhausted: current && state.exhausted,
    limited: current && state.limited,
    cancelled:
      input.enabled &&
      sourceKey !== null &&
      suppressed?.scope === requestScope &&
      suppressed.key === sourceKey,
  };
}
