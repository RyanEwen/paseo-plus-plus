import { createServer, type Server } from "node:http";
import { afterEach, expect, test, vi } from "vitest";

import { waitForMetro, warmMetro } from "../e2e/support/global-setup";

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
