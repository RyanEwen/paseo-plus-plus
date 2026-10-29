import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "jest-worker";
import { afterEach, expect, test, vi } from "vitest";

import { waitForMetro, warmMetro } from "../e2e/support/global-setup";

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

/** Own one real pool, a bounded rejection deadline, and its temporary worker files. */
async function withQueuedControlWorker(
  check: (fixture: {
    worker: QueuedControlWorker;
    original: QueuedControlReply;
    deadline: Promise<never>;
    attemptsPath: string;
    close: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "metro-worker-control-"));
  let worker: QueuedControlWorker | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Public Worker.end is single-use. Release our ownership before awaiting it.
  const close = async (): Promise<void> => {
    const current = worker;
    worker = null;
    await current?.end();
  };

  try {
    const modulePath = join(directory, "worker.cjs");
    const attemptsPath = join(directory, "attempts.txt");
    await writeFile(
      modulePath,
      `const { existsSync, readFileSync, writeFileSync } = require("node:fs");
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
`,
    );
    worker = new QueuedControlWorker(modulePath, {
      numWorkers: 1,
      enableWorkerThreads: true,
      exposedMethods: ["run"],
      maxRetries: 1,
      forkOptions: { execArgv: [] },
    });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Queued worker control did not settle within 4000 milliseconds"));
      }, 4_000);
    });
    const original = await Promise.race([worker.run("reply", "original-control"), deadline]);
    expect(original.body).toBe("original-control");
    expect(original.callNumber).toBe(1);
    expect(Number.isInteger(original.threadId)).toBe(true);
    expect(original.threadId).toBeGreaterThan(0);

    await check({ worker, original, deadline, attemptsPath, close });
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

class MetroPort {
  private readonly responses = new Map<string, { status: number; body: string }>();
  readonly requests: string[] = [];

  private constructor(
    readonly port: number,
    private readonly server: Server,
  ) {}

  static async listen(): Promise<MetroPort> {
    let endpoint!: MetroPort;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      endpoint.requests.push(pathname);
      const served = endpoint.responses.get(pathname) ?? { status: 500, body: "fallback" };
      response.writeHead(served.status, { "content-type": "text/plain" });
      response.end(served.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to listen for Metro readiness test");
    }
    endpoint = new MetroPort(address.port, server);
    return endpoint;
  }

  serveMetro(): void {
    this.responses.set("/status", { status: 200, body: "packager-status:running" });
  }

  serveWarmableDocument(): void {
    this.responses.set("/", {
      status: 200,
      body: '<html><script src="/index.bundle?platform=web"></script></html>',
    });
    this.responses.set("/index.bundle", { status: 200, body: "compiled bundle" });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

let endpoint: MetroPort | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await endpoint?.close();
  endpoint = null;
});

test("Metro readiness rejects another HTTP listener on the selected port", async () => {
  endpoint = await MetroPort.listen();

  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).rejects.toThrow(
    "Expected Metro status",
  );

  endpoint.serveMetro();
  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).resolves.toBe(
    undefined,
  );
});

test("Metro warmup compiles the document's same-origin scripts before tests start", async () => {
  endpoint = await MetroPort.listen();
  endpoint.serveWarmableDocument();

  await warmMetro(endpoint.port);

  expect(endpoint.requests).toEqual(["/", "/index.bundle"]);
});

test.each([
  { label: "default", configured: undefined, timeoutMs: 120_000 },
  { label: "approved override", configured: "300000", timeoutMs: 300_000 },
  { label: "maximum supported timer", configured: "2147483647", timeoutMs: 2_147_483_647 },
])("Metro warmup timeout applies $label before fetching", async ({ configured, timeoutMs }) => {
  vi.stubEnv("PASEO_E2E_METRO_WARMUP_TIMEOUT_MS", configured);
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const fetchRequest = vi.spyOn(globalThis, "fetch");
  endpoint = await MetroPort.listen();
  endpoint.serveWarmableDocument();

  await warmMetro(endpoint.port);

  expect(endpoint.requests).toEqual(["/", "/index.bundle"]);
  expect(timeout.mock.calls).toEqual([[timeoutMs], [timeoutMs]]);
  expect(fetchRequest).toHaveBeenCalledTimes(2);
  expect(fetchRequest.mock.calls[0]?.[1]?.signal).toBe(timeout.mock.results[0]?.value);
  expect(fetchRequest.mock.calls[1]?.[1]?.signal).toBe(timeout.mock.results[1]?.value);
});

test.each(["", "   ", "0", "-1", "1.5", "NaN", "Infinity", "2147483648", "9007199254740992"])(
  "Metro warmup timeout rejects %j before HTTP",
  async (configured) => {
    vi.stubEnv("PASEO_E2E_METRO_WARMUP_TIMEOUT_MS", configured);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    endpoint = await MetroPort.listen();
    endpoint.serveWarmableDocument();

    await expect(warmMetro(endpoint.port)).rejects.toThrow(
      "PASEO_E2E_METRO_WARMUP_TIMEOUT_MS must be a positive integer from 1 to 2147483647 milliseconds",
    );

    expect(timeout).not.toHaveBeenCalled();
    expect(endpoint.requests).toEqual([]);
  },
);

test("Metro worker queued terminal exit rejects A and runs B on a replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "metro-queued-terminal-"));
  let worker: QueuedTerminalExitWorker | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const modulePath = join(directory, "worker.cjs");
    await writeFile(
      modulePath,
      `const { threadId } = require("node:worker_threads");
exports.run = (task, body) => {
  if (task === "exit") {
    process.exit(0);
  }
  return { body, threadId };
};
`,
    );
    worker = new QueuedTerminalExitWorker(modulePath, {
      numWorkers: 1,
      enableWorkerThreads: true,
      exposedMethods: ["run"],
      forkOptions: { execArgv: [] },
    });

    // Leave room inside the unchanged test deadline for public pool cleanup.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error("Queued terminal worker recovery did not settle within 4000 milliseconds"),
        );
      }, 4_000);
    });
    const original = await Promise.race([worker.run("reply", "original-worker"), deadline]);
    expect(original.body).toBe("original-worker");
    expect(Number.isInteger(original.threadId)).toBe(true);
    expect(original.threadId).toBeGreaterThan(0);

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
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    try {
      await worker?.end();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
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
