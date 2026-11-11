export interface PromptReadingPosition {
  rowId: string | null;
  seq?: number | null;
  navigating: boolean;
  following: boolean;
  manual: boolean;
}

/** A reading sample; omitted fields take the defaults of a manual, unmeasured sample. */
export type PromptReadingUpdate = Pick<PromptReadingPosition, "rowId"> &
  Partial<Omit<PromptReadingPosition, "rowId">>;

export interface PromptReadingSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PromptReadingPosition;
}

/** Publish viewport ownership without rerendering the transcript on every scroll event. */
export function createPromptReadingPublisher() {
  let snapshot: PromptReadingPosition = {
    rowId: null,
    seq: null,
    navigating: false,
    following: false,
    manual: false,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(update: PromptReadingUpdate) {
      const { rowId, navigating = false, following = false, manual = true, seq = null } = update;
      if (
        snapshot.seq === seq &&
        snapshot.manual === manual &&
        snapshot.following === following &&
        snapshot.navigating === navigating &&
        snapshot.rowId === rowId
      )
        return;
      snapshot = {
        rowId,
        seq,
        navigating,
        following,
        manual,
      };
      for (const listener of listeners) listener();
    },
  };
}

export const EMPTY_PROMPT_READING_SOURCE: PromptReadingSource = createPromptReadingPublisher();
