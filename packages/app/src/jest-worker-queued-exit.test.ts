// Pins patches/jest-worker+29.7.0.patch: a terminal worker exit rejects only its own job and
// queued work runs on a replacement thread. Remove this file with that patch.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "jest-worker";
import { expect, test } from "vitest";

interface QueuedWorkerReply {
  body: string;
  threadId: number;
}

/** Type the public method bound by Jest from this test's temporary worker module. */
class QueuedTerminalExitWorker extends Worker {
  declare run: (task: "exit" | "reply", body: string) => Promise<QueuedWorkerReply>;
}

interface QueuedControlReply extends QueuedWorkerReply {
  callNumber: number;
}

/** Type the real worker methods used by the unchanged-policy controls below. */
class QueuedControlWorker extends Worker {
  declare run: (task: "reply" | "throw" | "retry", body: string) => Promise<QueuedControlReply>;
}

/** Worker module for the terminal-exit case: "exit" ends the thread, "reply" echoes. */
const TERMINAL_EXIT_WORKER_SOURCE = `const { threadId } = require("node:worker_threads");
exports.run = (task, body) => {
  if (task === "exit") {
    process.exit(0);
  }
  return { body, threadId };
};
`;

/** Worker module for the unchanged-policy controls: throw, a retried exit, and call counting. */
const CONTROL_WORKER_SOURCE = `const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { threadId } = require("node:worker_threads");
const attemptsPath = join(__dirname, "attempts.txt");
let calls = 0;
exports.run = (task, body) => {
  calls += 1;
  if (task === "throw") {
    throw new Error(body);
  }
  if (task === "retry") {
    const attempts = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) + 1 : 1;
    writeFileSync(attemptsPath, String(attempts));
    if (attempts === 1) {
      process.exit(7);
    }
  }
  return { body, threadId, callNumber: calls };
};
`;

interface QueuedWorkerSetup<TWorker extends Worker, TReply extends QueuedWorkerReply> {
  /** Temporary directory prefix. */
  prefix: string;
  /** CommonJS source of the worker module. */
  source: string;
  /** Build the pool from the written module path. */
  create: (modulePath: string) => TWorker;
  /** Run the first job, which proves the pool is up before the case under test. */
  runOriginal: (worker: TWorker) => Promise<TReply>;
  /** Body the first job echoes. */
  originalBody: string;
  /** Message the deadline rejects with. */
  deadlineMessage: string;
}

interface QueuedWorkerFixture<TWorker extends Worker, TReply extends QueuedWorkerReply> {
  worker: TWorker;
  original: TReply;
  deadline: Promise<never>;
  directory: string;
  close: () => Promise<void>;
}

/** Own one real pool, a bounded rejection deadline, and its temporary worker files. */
async function withQueuedWorker<TWorker extends Worker, TReply extends QueuedWorkerReply>(
  setup: QueuedWorkerSetup<TWorker, TReply>,
  check: (fixture: QueuedWorkerFixture<TWorker, TReply>) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), setup.prefix));
  let worker: TWorker | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Public Worker.end is single-use. Release our ownership before awaiting it.
  const close = async (): Promise<void> => {
    const current = worker;
    worker = null;
    await current?.end();
  };

  try {
    const modulePath = join(directory, "worker.cjs");
    await writeFile(modulePath, setup.source);
    const created = setup.create(modulePath);
    worker = created;
    // Leave room inside the test deadline for public pool cleanup.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(setup.deadlineMessage)), 4_000);
    });
    const original = await Promise.race([setup.runOriginal(created), deadline]);
    expect(original.body).toBe(setup.originalBody);
    expect(Number.isInteger(original.threadId)).toBe(true);
    expect(original.threadId).toBeGreaterThan(0);

    await check({ worker: created, original, deadline, directory, close });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    try {
      await close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** The control pool: one thread, one retry, and a per-thread call counter. */
async function withQueuedControlWorker(
  check: (
    fixture: QueuedWorkerFixture<QueuedControlWorker, QueuedControlReply> & {
      attemptsPath: string;
    },
  ) => Promise<void>,
): Promise<void> {
  await withQueuedWorker(
    {
      prefix: "metro-worker-control-",
      source: CONTROL_WORKER_SOURCE,
      create: (modulePath) =>
        new QueuedControlWorker(modulePath, {
          numWorkers: 1,
          enableWorkerThreads: true,
          exposedMethods: ["run"],
          maxRetries: 1,
          forkOptions: { execArgv: [] },
        }),
      runOriginal: (worker) => worker.run("reply", "original-control"),
      originalBody: "original-control",
      deadlineMessage: "Queued worker control did not settle within 4000 milliseconds",
    },
    async (fixture) => {
      expect(fixture.original.callNumber).toBe(1);
      await check({ ...fixture, attemptsPath: join(fixture.directory, "attempts.txt") });
    },
  );
}

test("Metro worker queued terminal exit rejects A and runs B on a replacement", async () => {
  await withQueuedWorker(
    {
      prefix: "metro-queued-terminal-",
      source: TERMINAL_EXIT_WORKER_SOURCE,
      create: (modulePath) =>
        new QueuedTerminalExitWorker(modulePath, {
          numWorkers: 1,
          enableWorkerThreads: true,
          exposedMethods: ["run"],
          forkOptions: { execArgv: [] },
        }),
      runOriginal: (worker) => worker.run("reply", "original-worker"),
      originalBody: "original-worker",
      deadlineMessage: "Queued terminal worker recovery did not settle within 4000 milliseconds",
    },
    async ({ worker, original, deadline }) => {
      // Queue B without yielding to the main-thread exit handler for A.
      const failed = expect(worker.run("exit", "job-A")).rejects.toThrow(
        "A Jest worker thread exited unexpectedly before finishing tests for an unknown reason.",
      );
      const queued = worker.run("reply", "queued-B");
      const [, reply] = await Promise.race([Promise.all([failed, queued]), deadline]);

      expect(reply.body).toBe("queued-B");
      expect(Number.isInteger(reply.threadId)).toBe(true);
      expect(reply.threadId).toBeGreaterThan(0);
      expect(reply.threadId).not.toBe(original.threadId);
    },
  );
});

test("Metro worker control preserves FIFO and repeatable fixture cleanup", async () => {
  await withQueuedControlWorker(async ({ worker, original, deadline, close }) => {
    const first = worker.run("reply", "queued-A");
    const second = worker.run("reply", "queued-B");
    const replies = await Promise.race([Promise.all([first, second]), deadline]);

    expect(replies).toEqual([
      { body: "queued-A", threadId: original.threadId, callNumber: 2 },
      { body: "queued-B", threadId: original.threadId, callNumber: 3 },
    ]);
    await close();
    await close();
    expect(() => worker.run("reply", "after-close")).toThrow(
      "Farm is ended, no more calls can be done to it",
    );
  });
});

test("Metro worker control keeps the same thread after an ordinary job error", async () => {
  await withQueuedControlWorker(async ({ worker, original, deadline }) => {
    const failed = expect(worker.run("throw", "ordinary queued failure")).rejects.toThrow(
      "ordinary queued failure",
    );
    const queued = worker.run("reply", "after-error");
    const [, reply] = await Promise.race([Promise.all([failed, queued]), deadline]);

    expect(reply).toEqual({ body: "after-error", threadId: original.threadId, callNumber: 3 });
  });
});

test("Metro worker control preserves the nonzero exit retry before queued work", async () => {
  await withQueuedControlWorker(async ({ worker, original, deadline, attemptsPath }) => {
    const retried = worker.run("retry", "retried-A");
    const queued = worker.run("reply", "after-retry");
    const [first, second] = await Promise.race([Promise.all([retried, queued]), deadline]);

    expect(first.body).toBe("retried-A");
    expect(first.callNumber).toBe(1);
    expect(Number.isInteger(first.threadId)).toBe(true);
    expect(first.threadId).toBeGreaterThan(0);
    expect(first.threadId).not.toBe(original.threadId);
    expect(second).toEqual({ body: "after-retry", threadId: first.threadId, callNumber: 2 });
    expect(await readFile(attemptsPath, "utf8")).toBe("2");
  });
});
