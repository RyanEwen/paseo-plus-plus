import { describe, expect, test } from "vitest";
import { createExtensionWorkerTracker, type TrackedExtensionWorker } from "./worker-tracking.js";

function worker(versionId: number): TrackedExtensionWorker {
  return { versionId, isDestroyed: () => false };
}

describe("extension worker tracking", () => {
  test("a started worker becomes ready when Chromium reports it running", async () => {
    const tracker = createExtensionWorkerTracker();
    const first = worker(7);
    tracker.starting(first);
    const ready = tracker.waitReady(7);
    tracker.running(7);
    await expect(ready).resolves.toBe(true);
    await expect(tracker.waitReady(7)).resolves.toBe(true);
    expect(tracker.isCurrent(first)).toBe(true);
    expect(tracker.workers()).toEqual([first]);
  });

  test("stopping before running reports not ready and forgets the worker", async () => {
    const tracker = createExtensionWorkerTracker();
    const first = worker(7);
    tracker.starting(first);
    const ready = tracker.waitReady(7);
    tracker.stopped(7);
    await expect(ready).resolves.toBe(false);
    expect(() => tracker.waitReady(7)).toThrow("Extension worker has not started.");
    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.workers()).toEqual([]);
  });

  test("a restart of the same version settles the earlier start as not ready", async () => {
    const tracker = createExtensionWorkerTracker();
    const first = worker(7);
    const second = worker(7);
    tracker.starting(first);
    const earlier = tracker.waitReady(7);
    tracker.starting(second);
    await expect(earlier).resolves.toBe(false);
    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(second)).toBe(true);
    tracker.running(7);
    await expect(tracker.waitReady(7)).resolves.toBe(true);
  });

  test("an unknown version has not started, and running it is a no-op", () => {
    const tracker = createExtensionWorkerTracker();
    tracker.running(3);
    expect(() => tracker.waitReady(3)).toThrow("Extension worker has not started.");
  });
});
