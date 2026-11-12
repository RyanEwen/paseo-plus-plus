import { coversCanonicalInterval } from "@/timeline/canonical-reading-source";
import type { CanonicalTimelineCoverage } from "@/timeline/canonical-prompt-model";
import type { PromptReadingPosition } from "./prompt-reading-position";
import type { ControlSize } from "@/components/ui/control-geometry";
import type { StreamItem } from "@/types/stream";
import type { ChatOutlinePrompt } from "./chat-outline/model";
import type { PromptDiscoveryStatus } from "./use-prompt-discovery";

export type UserPrompt = Extract<StreamItem, { kind: "user_message" }>;

interface PromptFeedbackState {
  busy: boolean;
  error: boolean;
  cancelled: boolean;
  discoveryStatus: PromptDiscoveryStatus;
}

interface RetainedContextFeedback {
  loading: boolean;
  error: boolean;
  cancelled: boolean;
  limited: boolean;
  exhausted: boolean;
}

const EMPTY_CONTEXT_FEEDBACK: RetainedContextFeedback = {
  loading: false,
  error: false,
  cancelled: false,
  limited: false,
  exhausted: false,
};

/** Passive context never covers an available prompt with loading feedback.
 * Explicit navigation keeps its own failure and retry, even if context also failed.
 * Without a prompt, the same rail owns the system placeholder and context retry.
 */
export function resolvePromptFeedback(
  navigation: PromptFeedbackState & { message: UserPrompt | undefined },
  context: RetainedContextFeedback = EMPTY_CONTEXT_FEEDBACK,
): PromptFeedbackState & { retryContext: boolean } {
  if (navigation.message) return { ...navigation, retryContext: false };
  const navigationNeedsRetry =
    navigation.error || navigation.cancelled || navigation.discoveryStatus === "limited";
  let discoveryStatus = navigation.discoveryStatus;
  if (!navigationNeedsRetry) {
    if (context.limited) discoveryStatus = "limited";
    else if (context.exhausted) discoveryStatus = "exhausted";
  }
  return {
    busy: navigation.busy || context.loading,
    error: navigation.error || context.error,
    cancelled: navigation.cancelled || context.cancelled,
    discoveryStatus,
    retryContext: !navigationNeedsRetry && (context.error || context.cancelled || context.limited),
  };
}

export interface PromptTarget {
  key: string;
  seq?: number;
  item?: UserPrompt;
  /** Cache content is not proof that the original row is loaded. */
  cached?: boolean;
}

/** Merge the complete daemon index with loaded prompts, including local submissions. */
export function buildPromptTargets(
  items: readonly StreamItem[],
  prompts: readonly ChatOutlinePrompt[],
  epoch: string | null,
  contextOnlyIds?: ReadonlySet<string>,
): PromptTarget[] {
  const targets: PromptTarget[] = prompts.map(({ seq }) => ({ key: `${epoch}:${seq}`, seq }));
  const bySeq = new Map(targets.map((target) => [target.seq, target]));
  const loadedIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "user_message" || loadedIds.has(item.id)) continue;
    loadedIds.add(item.id);
    const seq = item.timelineCursor?.epoch === epoch ? item.timelineCursor?.seq : undefined;
    const indexed = seq === undefined ? undefined : bySeq.get(seq);
    if (indexed) {
      indexed.item = item;
      if (contextOnlyIds?.has(item.id)) indexed.cached = true;
    } else {
      targets.push({
        key: seq === undefined ? item.id : `${epoch}:${seq}`,
        seq,
        item,
        ...(contextOnlyIds?.has(item.id) ? { cached: true } : {}),
      });
    }
  }
  // Unpositioned local submissions follow authoritative history in submission order.
  return targets.sort((left, right) => (left.seq ?? Infinity) - (right.seq ?? Infinity));
}

/** Resolve by durable identity; array offsets change when a page is loaded. */
export function findPromptTarget(targets: readonly PromptTarget[], item: UserPrompt): number {
  return targets.findIndex(
    (target) =>
      target.item?.id === item.id ||
      (item.timelineCursor !== undefined &&
        target.key === `${item.timelineCursor.epoch}:${item.timelineCursor.seq}`),
  );
}

/** Loading a served index or discovering history blocks duplicate navigation actions. */
export function isPromptNavigationBusy(input: {
  pending: boolean;
  jumping: boolean;
  discovering: boolean;
  indexed: boolean;
  epoch: string | null;
  cancelled: boolean;
  indexReady: boolean;
  indexError: boolean;
}): boolean {
  if (input.pending || input.jumping || input.discovering) return true;
  return (
    input.indexed &&
    input.epoch !== null &&
    !input.indexReady &&
    !input.indexError &&
    !input.cancelled
  );
}

/** Only a complete prompt index or exhausted pagination can establish the oldest bound. */
export function isPreviousPromptDisabled(input: {
  message: UserPrompt | undefined;
  indexed: boolean;
  position: number;
  hasOlder: boolean;
  indexReady: boolean;
  indexError: boolean;
}): boolean {
  if (!input.message || (input.indexed && !input.indexReady)) return true;
  const oldestKnown = input.indexed ? input.indexReady : !input.hasOlder;
  return input.position <= 0 && oldestKnown && !input.indexError;
}

/** Find the user turn at the reading edge, including indexed prompts outside the window. */
export function resolveReadingPromptTarget(
  items: readonly StreamItem[],
  targets: readonly PromptTarget[],
  rowId: string | null,
  readingSeq?: number | null,
): PromptTarget | undefined {
  // A published sequence needs no row scan; this runs on every streamed delta.
  const seq = readingSeq ?? items.find((item) => item.id === rowId)?.timelineCursor?.seq;
  if (seq !== undefined)
    return targets.findLast((target) => target.seq !== undefined && target.seq <= seq);
  const index = items.findIndex((item) => item.id === rowId);
  const user = items
    .slice(0, index + 1)
    .findLast((item): item is UserPrompt => item.kind === "user_message");
  return user ? targets.find((target) => target.item?.id === user.id) : undefined;
}

/** Resolve passive indexed content through the cache, including initial latest content. */
export function getMissingReadingPromptSeq(input: {
  navigating: boolean;
  intentional: boolean;
  indexed?: boolean;
  cancelled?: boolean;
  pending: boolean;
  target?: PromptTarget;
  latest?: PromptTarget;
  selected?: UserPrompt;
}): number | undefined {
  if (input.navigating || input.pending) return undefined;
  if (!input.intentional) {
    if (input.indexed && !input.cancelled && !input.selected && !input.latest?.item)
      return input.latest?.seq;
    return undefined;
  }
  if (input.target?.item) return undefined;
  return input.target?.seq;
}

/** Touch layouts keep a full 44 px tap target; pointer layouts use the 28 px dense size. */
export function promptArrowControlSize(isCompact: boolean): ControlSize {
  return isCompact ? "md" : "sm";
}

/** Discovery may also begin before the first loaded user message exists. */
export function shouldDiscoverPrompt(input: {
  previous: boolean;
  indexed: boolean;
  message: UserPrompt | undefined;
  cancelled: boolean;
  readingMissing: boolean;
}): boolean {
  const { previous, indexed, message, cancelled, readingMissing } = input;
  return previous || (!indexed && !cancelled && (!message || readingMissing));
}

/** The complete target order establishes the newer bound, including unloaded indexed prompts. */
export function isNextPromptDisabled(
  message: UserPrompt | undefined,
  position: number,
  count: number,
): boolean {
  return !message || position < 0 || position >= count - 1;
}

/** An index-free response can precede every loaded prompt; discover its own earlier prompt. */
export function needsReadingPromptDiscovery(
  indexed: boolean,
  manual: boolean,
  rowId: string | null,
  target: PromptTarget | undefined,
): boolean {
  return !indexed && manual && rowId !== null && target === undefined;
}

/** Keep discovery aimed at its original reading turn while older pages are prepended. */
export function hasDiscoveredPrompt(input: {
  previousMode: boolean;
  previous: PromptTarget | undefined;
  readingMode: boolean;
  target: PromptTarget | undefined;
  message: UserPrompt | undefined;
}): boolean {
  const { previousMode, previous, readingMode, target, message } = input;
  if (previousMode) return previous !== undefined;
  if (readingMode) return target !== undefined;
  return message !== undefined;
}

/** A missing active prompt gets discovery feedback instead of an unrelated loaded prompt. */
export function resolveStickyPromptMessage(input: {
  selected: UserPrompt | undefined;
  fetched: UserPrompt | undefined;
  readingMissing: boolean;
  missingSeq: number | undefined;
  canFetch: boolean;
}): UserPrompt | undefined {
  const { selected, fetched, readingMissing, missingSeq, canFetch } = input;
  if (readingMissing) return undefined;
  if (missingSeq !== undefined && canFetch) return fetched;
  return selected;
}

/** Published reading geometry owns physical context even while following output.
 * Before the viewport publishes an edge, use the latest canonical source, or its
 * loaded USER when ordinary coverage reaches the tail without holes. Semantic
 * latest navigation is independent of this source selection. */
export function resolveRetainedContextSource(
  items: readonly StreamItem[],
  epoch: string | null,
  reading: Pick<PromptReadingPosition, "navigating" | "following" | "rowId" | "seq">,
  coverage: readonly CanonicalTimelineCoverage[],
): StreamItem | undefined {
  if (reading.navigating) return undefined;
  if (reading.rowId !== null) return resolveContextSource(items, epoch, reading.rowId, reading.seq);

  let latest: StreamItem | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const cursor = item.timelineCursor;
    if (!cursor || cursor.epoch !== epoch) continue;
    latest ??= item;
    if (item.kind === "user_message") {
      const tailSeq = latest.timelineCursor!.seq;
      return coversCanonicalInterval(coverage, cursor.epoch, cursor.seq, tailSeq) ? item : latest;
    }
  }
  return latest;
}

/** Resolve a visible canonical source without conflating repeated provider message IDs. */
export function resolveContextSource(
  items: readonly StreamItem[],
  epoch: string | null,
  rowId: string | null,
  seq: number | null | undefined,
  requested = true,
): StreamItem | undefined {
  if (!requested) return undefined;
  const candidates = items.filter(
    (item) =>
      item.timelineCursor?.epoch === epoch &&
      (seq != null ? item.timelineCursor.seq === seq : item.id === rowId),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Tail rows by canonical position and id, built once per tail instead of once per delta. */
export interface ContextSourceIndex {
  bySeq: ReadonlyMap<number, readonly StreamItem[]>;
  byId: ReadonlyMap<string, readonly StreamItem[]>;
  /** Tail rows whose nearest preceding user row is the reader's pending submission. */
  pendingAnswerIds: ReadonlySet<string>;
  /** Whether the tail's last user row is a pending submission, governing the head's first rows. */
  endsInPendingTurn: boolean;
}

function appendIndexed<K>(index: Map<K, StreamItem[]>, key: K, item: StreamItem): void {
  const rows = index.get(key);
  if (rows) rows.push(item);
  else index.set(key, [item]);
}

export function indexContextSources(
  tail: readonly StreamItem[],
  epoch: string | null,
): ContextSourceIndex {
  const bySeq = new Map<number, StreamItem[]>();
  const byId = new Map<string, StreamItem[]>();
  const pendingAnswerIds = new Set<string>();
  let governedByPending = false;
  for (const item of tail) {
    if (item.kind === "user_message") governedByPending = isPendingSubmission(item);
    else if (governedByPending) pendingAnswerIds.add(item.id);
    if (item.timelineCursor?.epoch !== epoch) continue;
    appendIndexed(bySeq, item.timelineCursor.seq, item);
    appendIndexed(byId, item.id, item);
  }
  return { bySeq, byId, pendingAnswerIds, endsInPendingTurn: governedByPending };
}

/**
 * The reader's own submission before the daemon echoes it: a client message id and no canonical
 * position. The daemon may never echo it (hidden or suppressed user rows), so it can stay so.
 * Such a row is not a context source owner and is never pinned: it keeps its place in the
 * transcript until it has a history position.
 */
export function isPendingSubmission(item: StreamItem): boolean {
  return (
    item.kind === "user_message" &&
    item.timelineCursor === undefined &&
    item.clientMessageId !== undefined
  );
}

/**
 * Whether a row answers the reader's pending submission. Its prompt is that loaded row, so a
 * canonical context read would only repeat what the transcript already shows. Head rows look
 * back through the head first, then inherit the tail's last user row.
 */
function answersPendingSubmission(
  index: ContextSourceIndex,
  head: readonly StreamItem[],
  item: StreamItem,
): boolean {
  const headPosition = head.indexOf(item);
  if (headPosition === -1) return index.pendingAnswerIds.has(item.id);
  for (let position = headPosition - 1; position >= 0; position -= 1) {
    const previous = head[position]!;
    if (previous.kind === "user_message") return isPendingSubmission(previous);
  }
  return index.endsInPendingTurn;
}

interface IndexedContextSourceInput {
  index: ContextSourceIndex;
  items: readonly StreamItem[];
  head: readonly StreamItem[];
  epoch: string | null;
  reading: Pick<PromptReadingPosition, "navigating" | "following" | "rowId" | "seq">;
  coverage: readonly CanonicalTimelineCoverage[];
}

/** resolveRetainedContextSource for a stable tail: only the streaming head is scanned per delta.
 * Output answering the reader's pending submission is never a source; see answersPendingSubmission. */
export function resolveIndexedContextSource(
  input: IndexedContextSourceInput,
): StreamItem | undefined {
  const source = resolveReadingSource(input);
  if (!source) return undefined;
  return answersPendingSubmission(input.index, input.head, source) ? undefined : source;
}

/** The row whose prompt the reader needs, before the pending-submission rule applies. */
function resolveReadingSource(input: IndexedContextSourceInput): StreamItem | undefined {
  const { index, items, head, epoch, reading, coverage } = input;
  // Before the viewport publishes an edge the scan stops at the newest user row.
  if (reading.navigating || reading.rowId === null)
    return resolveRetainedContextSource(items, epoch, reading, coverage);
  const { rowId, seq } = reading;
  const indexed = seq != null ? index.bySeq.get(seq) : index.byId.get(rowId);
  const inHead = head.filter(
    (item) =>
      item.timelineCursor?.epoch === epoch &&
      (seq != null ? item.timelineCursor.seq === seq : item.id === rowId),
  );
  const candidates = [...(indexed ?? []), ...inHead];
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** The streaming head only matters to prompt work when it holds a user row. Returns one
 * stable empty list otherwise, so tail-derived prompt work survives stream ticks. */
export function selectPromptHead(head: readonly StreamItem[]): readonly StreamItem[] {
  return head.some((item) => item.kind === "user_message") ? head : NO_PROMPT_ROWS;
}

export const NO_PROMPT_ROWS: readonly StreamItem[] = Object.freeze([]);

/** Add cached content to navigation order without claiming the original row is loaded. */
export function mergeCachedPromptTarget(
  targets: PromptTarget[],
  fetched: UserPrompt | undefined,
  selected: UserPrompt | null,
  epoch: string | null,
): PromptTarget[] {
  const cached = fetched ?? selected;
  if (!cached || findPromptTarget(targets, cached) !== -1) return targets;
  const seq = cached.timelineCursor?.epoch === epoch ? cached.timelineCursor.seq : undefined;
  if (seq === undefined) return targets;
  return [...targets, { key: `${epoch}:${seq}`, seq, item: cached, cached: true }].sort(
    (a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity),
  );
}

/** Only manual missing context uses the passive reader; explicit jumps keep their selection. */
export function shouldReadContext(input: {
  enabled: boolean;
  missing: boolean;
  cancelled: boolean;
  navigating: boolean;
  pending: PromptTarget | "previous" | null;
}): boolean {
  const { enabled, missing, cancelled, navigating, pending } = input;
  return enabled && missing && !cancelled && !navigating && pending === null;
}

/** Freeze explicit selection while its original loads; otherwise use the active reading cache. */
export function resolveContextMessage(input: {
  pending: PromptTarget | "previous" | null;
  missing: boolean;
  selected: UserPrompt | undefined;
  fetched: UserPrompt | undefined;
  missingSeq: number | undefined;
  canFetch: boolean;
}): UserPrompt | undefined {
  const { pending, missing, selected, fetched, missingSeq, canFetch } = input;
  if (pending) return selected;
  if (missing) return fetched;
  return resolveStickyPromptMessage({
    selected,
    fetched,
    readingMissing: false,
    missingSeq,
    canFetch,
  });
}

/** Explicit cached-row revelation loads history; passive context never does. */
export function shouldDiscoverCachedPrompt(input: {
  pending: PromptTarget | "previous" | null;
  indexed: boolean;
  message: UserPrompt | undefined;
  cancelled: boolean;
  readingMissing: boolean;
}): boolean {
  const { pending, indexed, message, cancelled, readingMissing } = input;
  if (pending !== null && pending !== "previous" && pending.cached) return !indexed;
  if (readingMissing) return false;
  return shouldDiscoverPrompt({
    previous: pending === "previous",
    indexed,
    message,
    cancelled,
    readingMissing: false,
  });
}

/** Stop pagination only when the actual original row is loaded, not its cache copy. */
export function hasDiscoveredCachedPrompt(input: {
  pending: PromptTarget | "previous" | null;
  loaded: PromptTarget[];
  previous: PromptTarget | undefined;
  readingMissing: boolean;
  readingTarget: PromptTarget | undefined;
  message: UserPrompt | undefined;
}): boolean {
  const { pending, loaded, previous, readingMissing, readingTarget, message } = input;
  if (pending !== null && pending !== "previous" && pending.cached)
    return loaded.some(
      (target) => target.key === pending.key && target.item !== undefined && !target.cached,
    );
  return hasDiscoveredPrompt({
    previousMode: pending === "previous",
    previous,
    readingMode: readingMissing,
    target: readingTarget,
    message,
  });
}

/** Missing canonical identity is an actionable error, never a guessed source cursor. */
export function isContextSourceMissing(requested: boolean, source: StreamItem | undefined) {
  return requested && !source;
}

/** The sticky prompt's own selection and navigation outcome. */
export interface StickyPromptState {
  /** An explicitly held prompt; null shows the reading or latest prompt. */
  selected: UserPrompt | null;
  /** A target whose original row is loading, or a search for the previous prompt. */
  pending: PromptTarget | "previous" | null;
  error: boolean;
  cancelled: boolean;
}

export const INITIAL_STICKY_PROMPT_STATE: StickyPromptState = {
  selected: null,
  pending: null,
  error: false,
  cancelled: false,
};

/** Everything that changes the sticky prompt state, named for what happened. */
export type StickyPromptEvent =
  /** Manual reading or following output chose the prompt to hold (null for the latest). */
  | { type: "readingSelected"; selected: UserPrompt | null }
  /** A navigation or reveal starts; a previous failure no longer applies. */
  | { type: "selectionStarted" }
  /** A loaded target is shown at once (null when it is the latest prompt). */
  | { type: "targetShown"; selected: UserPrompt | null }
  /** A target's original row must load first. */
  | { type: "targetRequested"; target: PromptTarget }
  /** A cached target cannot be paged to without an index. */
  | { type: "targetUnreachable" }
  /** The pending target's original row arrived. */
  | { type: "pendingLoaded"; selected: UserPrompt | null }
  /** The pending target failed to materialize. */
  | { type: "pendingFailed" }
  /** Discovery for the previous prompt settled without finding one. */
  | { type: "previousNotFound" }
  /** Arrow or activated navigation holds the current prompt while it moves. */
  | { type: "navigationStarted"; selected: UserPrompt }
  /** No previous prompt is loaded yet; search older history for one. */
  | { type: "previousRequested" }
  /** Hold a prompt while its original row is revealed. */
  | { type: "revealStarted"; selected: UserPrompt | null }
  | { type: "cancelled" }
  /** Manual reading takes over from navigation without cancelling discovery. */
  | { type: "readingReviewed" }
  | { type: "latestFollowed" }
  | { type: "retried" }
  | { type: "enabled" }
  | { type: "disabled" }
  /** A new authoritative epoch resets prompt ownership; disabled panes stay cancelled. */
  | { type: "epochReplaced"; enabled: boolean };

/** Pure transition for the sticky prompt state. An event that changes nothing returns the
 * same state, so React skips the render exactly as it did for the equivalent setters. */
export function reduceStickyPromptState(
  state: StickyPromptState,
  event: StickyPromptEvent,
): StickyPromptState {
  const next = transitionStickyPromptState(state, event);
  const unchanged =
    next.selected === state.selected &&
    next.pending === state.pending &&
    next.error === state.error &&
    next.cancelled === state.cancelled;
  return unchanged ? state : next;
}

function transitionStickyPromptState(
  state: StickyPromptState,
  event: StickyPromptEvent,
): StickyPromptState {
  switch (event.type) {
    case "readingSelected":
      return { ...state, selected: event.selected };
    case "selectionStarted":
      return { ...state, error: false };
    case "targetShown":
      return { ...state, selected: event.selected, pending: null };
    case "targetRequested":
      return { ...state, pending: event.target };
    case "targetUnreachable":
    case "pendingFailed":
      return { ...state, error: true, pending: null };
    case "pendingLoaded":
      return { ...state, selected: event.selected, pending: null };
    case "previousNotFound":
      return { ...state, pending: null };
    case "navigationStarted":
      return { ...state, selected: event.selected, cancelled: false };
    case "previousRequested":
      return { ...state, pending: "previous" };
    case "revealStarted":
      return { ...state, selected: event.selected };
    case "cancelled":
      return { ...state, pending: null, error: false, cancelled: true };
    case "readingReviewed":
      return { ...state, pending: null, error: false, cancelled: false };
    case "latestFollowed":
      return { ...state, selected: null };
    case "retried":
      return { ...state, error: false, cancelled: false };
    case "enabled":
      return { ...state, cancelled: false };
    case "disabled":
      return { selected: null, pending: null, error: false, cancelled: true };
    case "epochReplaced":
      return { selected: null, pending: null, error: false, cancelled: !event.enabled };
  }
}
