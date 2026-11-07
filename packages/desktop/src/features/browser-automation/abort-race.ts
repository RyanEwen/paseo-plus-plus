/** Settle with a task, or reject with the signal's reason as soon as it aborts.
 * The task's own late rejection is still consumed, so an abandoned Electron
 * request never surfaces as an unhandled rejection.
 */
export function settleUnlessAborted<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return task();
    });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        return resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        return reject(error);
      },
    );
  });
}
