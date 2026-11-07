import { SessionDelivery } from "../owned-subscriptions/index.js";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { forkCapabilities } from "../../fork-capabilities.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import {
  DaemonSelfUpdateInProgressError,
  type DaemonSelfUpdateInput,
  type DaemonSelfUpdater,
} from "./daemon-self-updater.js";
import {
  DaemonSelfUpdateSessionController,
  type DaemonSelfUpdateSessionControllerOptions,
} from "./daemon-self-update-session-controller.js";

type TestUpdater = Pick<DaemonSelfUpdater, "update">;
type TestAvailabilityCheck = DaemonSelfUpdater["checkAvailability"];

/** Update tests never reach the availability check; fail loudly if one does. */
const unexpectedAvailabilityCheck: TestAvailabilityCheck = async () => {
  throw new Error("availability check should not run");
};

const unexpectedUpdate: TestUpdater["update"] = async () => {
  throw new Error("update should not run");
};
type RestartIntent = Parameters<DaemonSelfUpdateSessionControllerOptions["emitLifecycleIntent"]>[0];

interface ControllerHarness {
  controller: DaemonSelfUpdateSessionController;
  emitted: SessionOutboundMessage[];
  restartIntents: RestartIntent[];
}

function createController(input: {
  updater?: TestUpdater;
  checkAvailability?: TestAvailabilityCheck;
  daemonVersion?: string | null;
  desktopManaged?: boolean;
}): ControllerHarness {
  const emitted: SessionOutboundMessage[] = [];
  const restartIntents: RestartIntent[] = [];
  const controller = new DaemonSelfUpdateSessionController({
    clientId: "client-1",
    daemonVersion: input.daemonVersion ?? "0.1.15",
    desktopManaged: input.desktopManaged,
    emit: (msg) => {
      emitted.push(msg);
    },
    emitLifecycleIntent: (intent) => {
      restartIntents.push(intent);
    },
    sessionLogger: createTestLogger(),
    updater: {
      update: input.updater?.update ?? unexpectedUpdate,
      checkAvailability: input.checkAvailability ?? unexpectedAvailabilityCheck,
    },
  });

  return { controller, emitted, restartIntents };
}

const updateRequest: SessionInboundMessage = {
  type: "daemon.update.request",
  requestId: "update-1",
};

const availabilityRequest: SessionInboundMessage = {
  type: "daemon.update.check_availability.request",
  requestId: "check-1",
};

describe("DaemonSelfUpdateSessionController", () => {
  test("returns undefined synchronously for messages owned by another subsystem", () => {
    const updater: TestUpdater = {
      async update() {
        throw new Error("update should not run");
      },
    };
    const { controller, emitted, restartIntents } = createController({ updater });
    const message: SessionInboundMessage = {
      type: "daemon.get_status.request",
      requestId: "status-1",
    };

    const result = controller.dispatch(message);

    expect(result).toBeUndefined();
    expect(emitted).toEqual([]);
    expect(restartIntents).toEqual([]);
  });

  test("emits progress, response, and restart lifecycle intent after a successful update", async () => {
    let updateInput: DaemonSelfUpdateInput | null = null;
    const updater: TestUpdater = {
      async update(input) {
        updateInput = input;
        input.onProgress("starting");
        input.onProgress("installing");
        return { success: true, error: null, newVersion: "0.1.96" };
      },
    };
    const { controller, emitted, restartIntents } = createController({ updater });

    await controller.dispatch(updateRequest);

    expect(updateInput?.daemonVersion).toBe("0.1.15");
    expect(updateInput?.desktopManaged).toBe(false);
    expect(emitted).toEqual([
      {
        type: "daemon.update.progress",
        payload: {
          requestId: "update-1",
          phase: "starting",
        },
      },
      {
        type: "daemon.update.progress",
        payload: {
          requestId: "update-1",
          phase: "installing",
        },
      },
      {
        type: "daemon.update.response",
        payload: {
          requestId: "update-1",
          success: true,
          error: null,
          previousVersion: "0.1.15",
          newVersion: "0.1.96",
        },
      },
    ]);
    expect(restartIntents).toEqual([
      {
        type: "restart",
        clientId: "client-1",
        requestId: "update-1",
        reason: "daemon_update",
        keepTerminals: true,
      },
    ]);
  });

  test("emits a failed response without restart lifecycle intent", async () => {
    let updateInput: DaemonSelfUpdateInput | null = null;
    const updater: TestUpdater = {
      async update(input) {
        updateInput = input;
        return { success: false, error: "not an npm global install", newVersion: null };
      },
    };
    const { controller, emitted, restartIntents } = createController({
      updater,
      desktopManaged: true,
    });

    await controller.dispatch(updateRequest);

    expect(updateInput?.desktopManaged).toBe(true);
    expect(emitted).toEqual([
      {
        type: "daemon.update.response",
        payload: {
          requestId: "update-1",
          success: false,
          error: "not an npm global install",
          previousVersion: "0.1.15",
          newVersion: null,
        },
      },
    ]);
    expect(restartIntents).toEqual([]);
  });

  test("maps concurrent updates to rpc_error", async () => {
    const updater: TestUpdater = {
      async update() {
        throw new DaemonSelfUpdateInProgressError();
      },
    };
    const { controller, emitted, restartIntents } = createController({ updater });

    await controller.dispatch(updateRequest);

    expect(emitted).toEqual([
      {
        type: "rpc_error",
        payload: {
          requestId: "update-1",
          requestType: "daemon.update.request",
          error: "An update is already in progress",
          code: "already_updating",
        },
      },
    ]);
    expect(restartIntents).toEqual([]);
  });

  test("answers an availability check without updating or requesting a restart", async () => {
    const inputs: Parameters<TestAvailabilityCheck>[0][] = [];
    const { controller, emitted, restartIntents } = createController({
      async checkAvailability(input) {
        inputs.push(input);
        return { version: "0.1.16", reason: null };
      },
    });

    await controller.dispatch(availabilityRequest);

    expect(inputs).toEqual([{ daemonVersion: "0.1.15", desktopManaged: false }]);
    expect(emitted).toEqual([
      {
        type: "daemon.update.check_availability.response",
        payload: { requestId: "check-1", version: "0.1.16", reason: null },
      },
    ]);
    expect(restartIntents).toEqual([]);
  });

  test("reports a failed availability check as a reason without a version", async () => {
    const { controller, emitted } = createController({
      async checkAvailability() {
        throw new Error("npm is not available on this host");
      },
    });

    await controller.dispatch(availabilityRequest);

    expect(emitted).toEqual([
      {
        type: "daemon.update.check_availability.response",
        payload: {
          requestId: "check-1",
          version: null,
          reason: "npm is not available on this host",
        },
      },
    ]);
  });

  test("advertises the availability capability once this controller is loaded", () => {
    expect(forkCapabilities()).toMatchObject({ daemonUpdateAvailability: true });
  });
});

test("self-update progress is request-owned through the final delivery boundary", async () => {
  const source = {},
    sibling = {};
  const frames: SessionOutboundMessage[] = [];
  const delivery = new SessionDelivery((socket, message) => {
    expect(socket).toBe(source);
    expect(delivery.permits(source, message)).toBe(true);
    expect(delivery.permits(sibling, message)).toBe(false);
    frames.push(message);
  });
  delivery.attach(source, true);
  delivery.attach(sibling, true);
  let lateProgress: (() => void) | undefined;
  const controller = new DaemonSelfUpdateSessionController({
    clientId: "safe-update",
    daemonVersion: "0.8.0",
    sessionLogger: createTestLogger(),
    emit: (message) => {
      delivery.reply(message);
    },
    emitLifecycleIntent: () => {
      throw new Error("No restart is allowed in this test");
    },
    updater: {
      async update(input) {
        input.onProgress("starting");
        await Promise.resolve();
        input.onProgress("installing");
        lateProgress = () => input.onProgress("starting");
        return { success: false, error: "Safe injected update stopped", newVersion: null };
      },
      checkAvailability: unexpectedAvailabilityCheck,
    },
  });
  await delivery.request(source, updateRequest, async () => {
    await controller.dispatch(updateRequest);
  });
  expect(frames.map((message) => message.type)).toEqual([
    "daemon.update.progress",
    "daemon.update.progress",
    "daemon.update.response",
  ]);
  lateProgress?.();
  expect(frames).toHaveLength(3);
});
