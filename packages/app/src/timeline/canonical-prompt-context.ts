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
export interface RetainedPromptSnapshot {
  epoch: string;
  contexts: readonly CanonicalPromptContext[];
  /** Isolated canonical points never extend viewed contiguous coverage. */
  ranges: readonly { startSeq: number; endSeq: number }[];
}
interface ReaderLease {
  agentId: string;
  epoch: string;
  contexts: readonly CanonicalPromptContext[];
  continuations: Map<string, CanonicalPromptContextProgress>;
}
const MAX_CONTEXTS_PER_READER = 4;
const EMPTY: readonly CanonicalPromptContext[] = Object.freeze([]);
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

/** The viewed owner retains actual canonical rows without applying a window.
 * Reader leases isolate split panes; one pane cannot evict another pane's row.
 */
export function createCanonicalPromptContexts(
  acceptsEpoch: (agentId: string, epoch: string) => boolean = () => true,
) {
  const snapshots = new Map<string, RetainedPromptSnapshot>();
  const readers = new Map<object, ReaderLease>();
  const listeners = new Set<() => void>();
  const channels = new Map<object, object>();
  let disposed = false;
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const publish = (agentId: string, epoch: string) => {
    const contexts = Array.from(readers.values())
      .filter((reader) => reader.agentId === agentId && reader.epoch === epoch)
      .flatMap((reader) => reader.contexts);
    const points = Array.from(
      new Set(contexts.map(({ prompt }) => prompt.timelineCursor!.seq)),
    ).sort((a, b) => a - b);
    snapshots.set(agentId, {
      epoch,
      contexts,
      ranges: points.map((seq) => ({ startSeq: seq, endSeq: seq })),
    });
    emit();
  };
  const setEpoch = (agentId: string, epoch: string) => {
    if (disposed || !acceptsEpoch(agentId, epoch) || snapshots.get(agentId)?.epoch === epoch)
      return;
    for (const [channel, reader] of readers)
      if (reader.agentId === agentId) {
        readers.delete(channel);
        channels.delete(channel);
      }
    snapshots.set(agentId, { epoch, contexts: EMPTY, ranges: [] });
    emit();
  };
  const admit = (reader: ReaderLease, proof: CanonicalPromptContext) => {
    reader.contexts = [
      ...reader.contexts.filter((item) => item.sourceKey !== proof.sourceKey),
      proof,
    ].slice(-MAX_CONTEXTS_PER_READER);
    publish(reader.agentId, reader.epoch);
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read(
      agentId: string,
      epoch: string | null,
      channel?: object,
    ): readonly CanonicalPromptContext[] {
      if (channel) {
        const reader = readers.get(channel);
        return reader?.agentId === agentId && reader.epoch === epoch ? reader.contexts : EMPTY;
      }
      const snapshot = snapshots.get(agentId);
      return snapshot?.epoch === epoch ? snapshot.contexts : EMPTY;
    },
    snapshot(agentId: string) {
      return snapshots.get(agentId);
    },
    setEpoch,
    cancel(channel: object) {
      channels.delete(channel);
    },
    release(channel: object) {
      channels.delete(channel);
      const reader = readers.get(channel);
      if (!reader) return;
      readers.delete(channel);
      if (!disposed && snapshots.get(reader.agentId)?.epoch === reader.epoch)
        publish(reader.agentId, reader.epoch);
    },
    retainAgents(agentIds: readonly string[]) {
      const retained = new Set(agentIds);
      for (const id of snapshots.keys()) if (!retained.has(id)) snapshots.delete(id);
      for (const [channel, reader] of readers)
        if (!retained.has(reader.agentId)) {
          readers.delete(channel);
          channels.delete(channel);
        }
      emit();
    },
    async request(input: {
      agentId: string;
      source: StreamItem;
      channel: object;
      signal: AbortSignal;
      fetchContext(
        source: StreamItem,
        signal: AbortSignal,
        progress?: CanonicalPromptContextProgress,
      ): Promise<CanonicalPromptContext | undefined>;
    }): Promise<Prompt | undefined> {
      const epoch = input.source.timelineCursor?.epoch;
      if (disposed || !epoch || input.signal.aborted || !acceptsEpoch(input.agentId, epoch))
        throw new Error("Prompt context owner unavailable");
      setEpoch(input.agentId, epoch);
      let reader = readers.get(input.channel);
      if (reader && (reader.agentId !== input.agentId || reader.epoch !== epoch))
        throw new Error("Prompt reader scope changed");
      if (!reader) {
        reader = { agentId: input.agentId, epoch, contexts: EMPTY, continuations: new Map() };
        readers.set(input.channel, reader);
      }
      const key = canonicalPromptSourceKey(input.source);
      const generation = {};
      channels.set(input.channel, generation);
      const own = reader.contexts.find((item) => item.sourceKey === key);
      if (own) return own.prompt;
      const cached = snapshots.get(input.agentId)!.contexts.find((item) => item.sourceKey === key);
      if (cached) {
        admit(reader, cached);
        return cached.prompt;
      }
      const isCurrent = () =>
        !disposed &&
        !input.signal.aborted &&
        acceptsEpoch(input.agentId, epoch) &&
        channels.get(input.channel) === generation &&
        readers.get(input.channel) === reader &&
        snapshots.get(input.agentId)?.epoch === epoch;
      let proof: CanonicalPromptContext | undefined;
      try {
        proof = await input.fetchContext(input.source, input.signal, reader.continuations.get(key));
      } catch (error) {
        if (!isCurrent())
          throw new Error("Prompt context request is no longer current", { cause: error });
        if (
          error instanceof CanonicalPromptContextBudgetError &&
          error.progress.sourceKey === key
        ) {
          reader.continuations.delete(key);
          reader.continuations.set(key, error.progress);
          if (reader.continuations.size > MAX_CONTEXTS_PER_READER)
            reader.continuations.delete(reader.continuations.keys().next().value!);
        }
        throw error;
      }
      if (!isCurrent()) throw new Error("Prompt context request is no longer current");
      reader.continuations.delete(key);
      if (!proof) return undefined;
      validatePromptPredecessor(input.source, proof);
      admit(reader, proof);
      return proof.prompt;
    },
    dispose() {
      disposed = true;
      channels.clear();
      readers.clear();
      snapshots.clear();
      emit();
      listeners.clear();
    },
  };
}
export type CanonicalPromptContexts = ReturnType<typeof createCanonicalPromptContexts>;

/** The ordinary canonical revision wins as a retained point enters the viewed range. */
export function mergeRetainedPrompts(
  items: StreamItem[],
  retained: readonly CanonicalPromptContext[],
  head: readonly StreamItem[] = [],
): StreamItem[] {
  const ordinary = [...items, ...head];
  const ids = new Set(ordinary.map((item) => item.id));
  const positions = new Set(
    ordinary.flatMap((item) =>
      item.timelineCursor ? [`${item.timelineCursor.epoch}:${item.timelineCursor.seq}`] : [],
    ),
  );
  const added: Prompt[] = [];
  for (let index = retained.length - 1; index >= 0; index -= 1) {
    const { prompt } = retained[index]!;
    const key = `${prompt.timelineCursor?.epoch}:${prompt.timelineCursor?.seq}`;
    if (ids.has(prompt.id) || positions.has(key)) continue;
    ids.add(prompt.id);
    positions.add(key);
    added.push(prompt);
  }
  if (!added.length) return items;
  const merged = [...items];
  for (const prompt of added.sort((a, b) => a.timelineCursor!.seq - b.timelineCursor!.seq)) {
    const index = merged.findIndex(
      (item) =>
        item.timelineCursor?.epoch === prompt.timelineCursor!.epoch &&
        item.timelineCursor.seq > prompt.timelineCursor!.seq,
    );
    if (index < 0) merged.push(prompt);
    else merged.splice(index, 0, prompt);
  }
  return merged;
}

/** Membership follows the winning full canonical revision before presentation.
 * A local slice must not restore stale content or bypass a plugin's projection.
 */
export function retainedCanonicalPositions(
  items: readonly StreamItem[],
  retained: readonly CanonicalPromptContext[],
): ReadonlySet<string> {
  const ids = new Set(retained.map(({ prompt }) => prompt.id));
  const positions = new Set(
    retained.map(({ prompt }) => `${prompt.timelineCursor!.epoch}:${prompt.timelineCursor!.seq}`),
  );
  return new Set(
    items.flatMap((item) => {
      const cursor = item.timelineCursor;
      if (!cursor || (!ids.has(item.id) && !positions.has(`${cursor.epoch}:${cursor.seq}`)))
        return [];
      return [`${cursor.epoch}:${cursor.seq}`];
    }),
  );
}

function validatePromptPredecessor(source: StreamItem, proof: CanonicalPromptContext): void {
  const position = source.timelineCursor;
  const cursor = proof.prompt.timelineCursor;
  if (
    !position ||
    !cursor ||
    cursor.epoch !== position.epoch ||
    !Number.isInteger(cursor.seq) ||
    cursor.seq < 0
  )
    throw new Error("Prompt predecessor relation is invalid");
  if (proof.sourceKey !== canonicalPromptSourceKey(source) || proof.sourceEnd !== position.seq)
    throw new Error("Prompt predecessor relation is invalid");
  const validStart =
    Number.isInteger(proof.sourceStart) &&
    proof.sourceStart >= 0 &&
    proof.sourceStart <= proof.sourceEnd;
  if (!validStart || cursor.seq >= proof.sourceStart)
    throw new Error("Prompt predecessor relation is invalid");
}
