import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import type { AppSettingsSnapshot } from "@getpaseo/protocol/app-settings";
import { createSettingsHostTransport } from "./transport";
import { deferred, snapshot } from "./test-support";

type Client = Parameters<typeof createSettingsHostTransport>[0]["client"];
type Observation = ReturnType<Client["observeAppSettings"]>;
type Handlers = Parameters<Observation["subscribe"]>[0];

/**
 * A settings client whose observations settle when the test says so. `beforeReady` runs just
 * before an observation becomes ready, which places an abort between readiness and adoption.
 */
function fakeSettingsClient(options: { beforeReady?: () => void } = {}) {
  const info = ServerInfoStatusPayloadSchema.parse({
    status: "server_info",
    serverId: "H",
    permissions: ["daemon.read"],
    features: { appSettingsSync: true },
  });
  type Recorded = { handlers: Handlers | null; released: boolean };
  const observations: Recorded[] = [];
  const client: Client = {
    getLastServerInfoMessage: () => info,
    patchAppSettings: async () => ({
      requestId: "patch",
      snapshot: snapshot("host"),
      conflicts: [],
    }),
    observeAppSettings: () => {
      const id = String(observations.length);
      const observation: Recorded = { handlers: null, released: false };
      observations.push(observation);
      const ready = deferred<Awaited<Observation["ready"]>>();
      queueMicrotask(() => {
        options.beforeReady?.();
        ready.resolve({ requestId: id, subscriptionId: id, snapshot: snapshot("host") });
      });
      return {
        subscriptionId: id,
        ready: ready.promise,
        subscribe: (handlers) => {
          observation.handlers = handlers;
          return () => {
            observation.handlers = null;
          };
        },
        release: async () => {
          observation.released = true;
        },
      };
    },
  };
  return { client, observations };
}

/** An AbortController whose signal has the reduced surface of the React Native runtime. */
function nativeAbortController(options: { withReason: boolean }): AbortController {
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
  if (!options.withReason) Object.defineProperty(controller.signal, "reason", { value: undefined });
  return controller;
}

describe("settings host transport cancellation", () => {
  it("stops before observing the host when a native signal is already aborted without a reason", async () => {
    const { client, observations } = fakeSettingsClient();
    const controller = nativeAbortController({ withReason: false });
    controller.abort();
    const transport = createSettingsHostTransport({
      client,
      signal: controller.signal,
      onSnapshot: () => {},
    });

    await expect(transport.read()).rejects.toMatchObject({
      name: "AbortError",
      message: "Settings read aborted",
    });
    expect(observations).toHaveLength(0);
  });

  it("keeps the abort reason and releases the observation when cancelled before adoption", async () => {
    const controller = nativeAbortController({ withReason: true });
    const reason = new Error("Settings host changed");
    const { client, observations } = fakeSettingsClient({
      beforeReady: () => controller.abort(reason),
    });
    const updates: AppSettingsSnapshot[] = [];
    const transport = createSettingsHostTransport({
      client,
      signal: controller.signal,
      onSnapshot: (value) => {
        updates.push(value);
      },
    });

    await expect(transport.read()).rejects.toBe(reason);

    expect(observations).toHaveLength(1);
    const [observation] = observations;
    expect(observation!.released).toBe(true);
    // The transport stopped listening, so a late change cannot reach the caller.
    expect(observation!.handlers).toBeNull();
    expect(updates).toEqual([]);
  });
});
