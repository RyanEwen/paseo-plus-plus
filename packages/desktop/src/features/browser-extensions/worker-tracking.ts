/** The part of a service worker the tracker needs: its identity and liveness. */
export interface TrackedExtensionWorker {
  readonly versionId: number;
  isDestroyed(): boolean;
}

interface WorkerEntry<TWorker> {
  worker: TWorker;
  /** Resolves true once Chromium reports the worker running, false if it stops or restarts first. */
  ready: Promise<boolean>;
  /** Settles `ready`; null once settled. */
  settle: ((ready: boolean) => void) | null;
}

/**
 * Track running extension service workers by Chromium version ID, with one readiness promise per
 * start. Chromium reports "running" after evaluating the background entry script, so readiness
 * means its listeners are registered.
 */
export function createExtensionWorkerTracker<TWorker extends TrackedExtensionWorker>() {
  const entries = new Map<number, WorkerEntry<TWorker>>();

  /** A (re)starting worker replaces any earlier start of the same version, which is never ready. */
  function starting(worker: TWorker): void {
    entries.get(worker.versionId)?.settle?.(false);
    let settle!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    entries.set(worker.versionId, { worker, ready, settle });
  }

  function running(versionId: number): void {
    const entry = entries.get(versionId);
    entry?.settle?.(true);
    if (entry) {
      entry.settle = null;
    }
  }

  function stopped(versionId: number): void {
    entries.get(versionId)?.settle?.(false);
    entries.delete(versionId);
  }

  /** @throws When the version has not started, or has since stopped. */
  function waitReady(versionId: number): Promise<boolean> {
    const entry = entries.get(versionId);
    if (!entry) {
      throw new Error("Extension worker has not started.");
    }
    return entry.ready;
  }

  /** True while `worker` is still the tracked instance for its version. */
  function isCurrent(worker: TWorker): boolean {
    return entries.get(worker.versionId)?.worker === worker;
  }

  function workers(): TWorker[] {
    return [...entries.values()].map((entry) => entry.worker);
  }

  return { starting, running, stopped, waitReady, isCurrent, workers };
}
