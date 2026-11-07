import type { SshDestination } from "./ssh-destination";
import type { ImportedPrivateKey, SshKeyImport } from "./ssh-key-import-model";

type HeldOperation = "pick" | "inspect" | "stage" | "commit";

/** Lets a test finish one held call at the moment it chooses. */
export interface HeldCall<T> {
  release(value: T): void;
}

interface HeldValues {
  pick: ImportedPrivateKey | null;
  inspect: string;
  stage: undefined;
  commit: undefined;
}

/** An in-memory Android key import: records calls and can fail or hold the next one. */
export interface TestSshKeyImport extends SshKeyImport {
  readonly calls: {
    readonly picks: number;
    readonly inspect: readonly SshDestination[];
    readonly stage: readonly string[];
    readonly commit: readonly string[];
    readonly discard: readonly string[];
  };
  /** Reject the next inspection with `error`. */
  failNextInspect(error: Error): void;
  /** Keep the next call of `operation` pending until the returned handle releases it. */
  holdNext<K extends HeldOperation>(operation: K): HeldCall<HeldValues[K]>;
}

/**
 * Build a key import whose picker returns `id_ed25519` and whose server reports
 * `SHA256:test-server` unless a test holds or fails the call.
 */
export function createTestSshKeyImport(): TestSshKeyImport {
  const calls = {
    picks: 0,
    inspect: [] as SshDestination[],
    stage: [] as string[],
    commit: [] as string[],
    discard: [] as string[],
  };
  const inspectFailures: Error[] = [];
  const held = new Map<HeldOperation, Promise<unknown>>();

  /** Consume the hold for `operation`, if any, and wait for its value. */
  async function settle<T>(operation: HeldOperation, fallback: T): Promise<T> {
    const pending = held.get(operation);
    if (!pending) return fallback;
    held.delete(operation);
    return (await pending) as T;
  }

  return {
    calls,
    failNextInspect(error) {
      inspectFailures.push(error);
    },
    holdNext(operation) {
      let release: (value: never) => void = () => {};
      held.set(
        operation,
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      return { release: (value) => release(value as never) };
    },
    async importPrivateKey() {
      calls.picks += 1;
      return settle<ImportedPrivateKey | null>("pick", {
        name: "id_ed25519",
        text: "test-private-key",
      });
    },
    bridge: {
      async inspect(target) {
        calls.inspect.push(target);
        const failure = inspectFailures.shift();
        if (failure) throw failure;
        return settle("inspect", "SHA256:test-server");
      },
      async stage(id) {
        calls.stage.push(id);
        await settle("stage", undefined);
      },
      async commit(id) {
        calls.commit.push(id);
        await settle("commit", undefined);
      },
      async discard(id) {
        calls.discard.push(id);
      },
    },
  };
}
