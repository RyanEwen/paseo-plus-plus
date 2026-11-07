/** Runs an operation after every earlier operation that shares its key has settled. */
export type KeyedSerializer = <T>(key: string, operation: () => Promise<T>) => Promise<T>;

/**
 * Create a serializer that runs operations sharing a key one at a time, in call order.
 *
 * Operations with different keys run independently. A failed operation still releases its
 * key, so it cannot block the next caller. Callers normalize keys themselves.
 */
export function createKeyedSerializer(): KeyedSerializer {
  const tails = new Map<string, Promise<void>>();

  return async (key, operation) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(key, current);

    try {
      await previous;
      return await operation();
    } finally {
      // Only resolved barriers are queued, so a failed operation cannot poison its successor.
      release();
      if (tails.get(key) === current) {
        tails.delete(key);
      }
    }
  };
}
