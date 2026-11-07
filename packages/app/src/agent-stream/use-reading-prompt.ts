import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem } from "@/types/stream";
import { retainBounded } from "@/timeline/canonical-prompt-model";
import { contextSourceKey } from "@/timeline/read-canonical-prompt-context";
import type { UserPrompt } from "./sticky-prompt-model";

/** The prompt to read for the reading position: the user row before a response source, or
 * an indexed prompt by sequence. The reader is absent while another owner supplies it. */
export type ReadingPromptRequest =
  | {
      kind: "context";
      source: StreamItem;
      fetchContext:
        | ((source: StreamItem, signal: AbortSignal) => Promise<UserPrompt | undefined>)
        | undefined;
    }
  | {
      kind: "prompt";
      seq: number;
      fetchPrompt: ((seq: number) => Promise<UserPrompt>) | undefined;
    };

/** Prompts and reading contexts kept per epoch for revisiting nearby responses. */
const MAX_CACHED_PROMPTS = 16;

/** Read only the prompt belonging to a visible response. This cache never applies a
 * transcript window or owns scrolling. Epoch-scoped state and cancellation isolate its bounded contents without remounting the viewport.
 */
export function useReadingPrompt(input: {
  epoch: string | null;
  knownPrompts: readonly UserPrompt[];
  request: ReadingPromptRequest | undefined;
}) {
  const { epoch, request } = input;
  const desiredKey = readingCacheKey(request);
  const readContent = useStableEvent(async (signal: AbortSignal) => {
    const current = input.request;
    if (current?.kind === "context" && current.fetchContext) {
      const item = await current.fetchContext(current.source, signal);
      if (item && item.timelineCursor?.epoch !== current.source.timelineCursor?.epoch)
        throw new Error("Reading prompt belongs to a different epoch");
      return item;
    }
    if (current?.kind === "prompt" && current.fetchPrompt) return current.fetchPrompt(current.seq);
    throw new Error("Reading prompt has no reader");
  });
  const contentScope = useMemo(
    () => ({ epoch, cache: new Map<string, UserPrompt | undefined>() }),
    [epoch],
  );
  const cache = contentScope.cache;
  const ownerEpoch = useRef(epoch);
  const operation = useRef<{ cancelled: boolean; controller: AbortController } | null>(null);
  const suppressedSeq = useRef<string | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    epoch: string | null;
    key: string | undefined;
    loading: boolean;
    error: boolean;
    item?: UserPrompt;
  }>({ epoch, key: undefined, loading: false, error: false });
  const cancel = useStableEvent(() => {
    if (operation.current) {
      operation.current.cancelled = true;
      operation.current.controller.abort();
    }
    suppressedSeq.current = desiredKey;
    setState((current) => ({ ...current, loading: false, error: false }));
  });
  const retry = useStableEvent(() => {
    suppressedSeq.current = undefined;
    setRevision((current) => current + 1);
  });
  // Invalidate old completions and cancellation suppression before passive reads run.
  useLayoutEffect(() => {
    if (ownerEpoch.current === epoch) return;
    ownerEpoch.current = epoch;
    if (operation.current) {
      operation.current.cancelled = true;
      operation.current.controller.abort();
    }
    operation.current = null;
    suppressedSeq.current = undefined;
    setRevision(0);
    setState({ epoch, key: undefined, loading: false, error: false });
  }, [epoch]);
  useEffect(() => {
    for (const item of input.knownPrompts) {
      const seq = item.timelineCursor?.seq;
      if (seq === undefined || item.timelineCursor?.epoch !== epoch) continue;
      retainBounded(cache, `prompt:${seq}`, item, MAX_CACHED_PROMPTS);
    }
  }, [input.knownPrompts, cache, epoch]);
  const canRead = hasReadingPromptReader(request);
  useEffect(() => {
    const key = desiredKey;
    if (key === undefined || suppressedSeq.current === key || !canRead) return;
    if (cache.has(key)) {
      setState({ epoch, key, loading: false, error: false, item: cache.get(key) });
      return;
    }
    const current = { cancelled: false, controller: new AbortController() };
    operation.current = current;
    setState({ epoch, key, loading: true, error: false });
    void (async () => {
      try {
        const item = await readContent(current.controller.signal);
        if (current.cancelled || ownerEpoch.current !== epoch) return;

        retainBounded(cache, key, item, MAX_CACHED_PROMPTS);
        setState({ epoch, key, loading: false, error: false, item });
      } catch {
        if (!current.cancelled && ownerEpoch.current === epoch)
          setState({ epoch, key, loading: false, error: true });
      }
    })();
    return () => {
      current.cancelled = true;
      current.controller.abort();
    };
  }, [desiredKey, canRead, readContent, revision, cache, epoch]);

  return {
    item: state.epoch === epoch && state.key === desiredKey ? state.item : undefined,
    loading:
      desiredKey !== undefined &&
      state.epoch === epoch &&
      state.key === desiredKey &&
      state.loading,
    error:
      desiredKey !== undefined && state.epoch === epoch && state.key === desiredKey && state.error,
    cancel,
    retry,
  };
}

/** Keep source identity stable while response text streams; both read types share one cache. */
function readingCacheKey(request: ReadingPromptRequest | undefined) {
  if (request?.kind === "context") return `context:${contextSourceKey(request.source)}`;
  if (request?.kind === "prompt") return `prompt:${request.seq}`;
  return undefined;
}

/** A known request can still lack its reader, for example while retained context manages it. */
function hasReadingPromptReader(request: ReadingPromptRequest | undefined): boolean {
  if (request?.kind === "context") return !!request.fetchContext;
  return !!request?.fetchPrompt;
}
