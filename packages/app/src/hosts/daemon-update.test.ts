import { describe, expect, test } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";
import {
  runDaemonUpdateAttempt,
  type DaemonUpdateAttempt,
  type DaemonUpdatePort,
  type DaemonUpdateState,
} from "./daemon-update";

const t = i18n.getFixedT("en");
const host = { serverId: "host-a", label: "Host A" };

type ProgressListener = Parameters<DaemonUpdatePort["subscribeProgress"]>[0];
type InstallResult = Awaited<ReturnType<DaemonUpdatePort["updateDaemon"]>>;

interface FakeDaemon {
  port: DaemonUpdatePort;
  requestIds: string[];
  listeners: Set<ProgressListener>;
}

/**
 * A daemon whose install replaces the worker with the installed version, reporting progress
 * for the request and for an unrelated request on the way.
 */
function createFakeDaemon(install?: (requestId: string) => InstallResult): FakeDaemon {
  let pid = 1;
  let version = "0.11.1-preview.12";
  const requestIds: string[] = [];
  const listeners = new Set<ProgressListener>();
  const port: DaemonUpdatePort = {
    async updateDaemon(requestId) {
      requestIds.push(requestId);
      for (const listener of listeners) {
        listener({ requestId: "someone-else", phase: "downloading" });
        listener({ requestId, phase: "installing" });
      }
      if (install) return install(requestId);
      pid = 2;
      version = "0.11.1-preview.13";
      return { success: true, error: null, newVersion: version };
    },
    getStatus: async () => ({ pid, version, serverId: host.serverId }),
    subscribeProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { port, requestIds, listeners };
}

interface AttemptHarness {
  attempt: DaemonUpdateAttempt;
  states: DaemonUpdateState[];
  confirmations: ConfirmDialogInput[];
}

function createAttempt(overrides: Partial<DaemonUpdateAttempt> = {}): AttemptHarness {
  const states: DaemonUpdateState[] = [];
  const confirmations: ConfirmDialogInput[] = [];
  const attempt: DaemonUpdateAttempt = {
    host,
    port: createFakeDaemon().port,
    isConnected: () => true,
    confirm: async (input) => {
      confirmations.push(input);
      return true;
    },
    t,
    onState: (state) => states.push(state),
    isActive: () => true,
    ...overrides,
  };
  return { attempt, states, confirmations };
}

describe("runDaemonUpdateAttempt", () => {
  test("reports a host without a client as unavailable without asking for confirmation", async () => {
    const { attempt, states, confirmations } = createAttempt({ port: null });

    await expect(runDaemonUpdateAttempt(attempt)).resolves.toBe("settled");

    expect(confirmations).toEqual([]);
    expect(states).toEqual([
      {
        status: "failed",
        title: t("settings.host.daemon.update.unavailableTitle"),
        message: t("settings.host.daemon.update.unavailableMessage"),
      },
    ]);
  });

  test("reports a disconnected host as offline without asking for confirmation", async () => {
    const { attempt, states, confirmations } = createAttempt({ isConnected: () => false });

    await expect(runDaemonUpdateAttempt(attempt)).resolves.toBe("settled");

    expect(confirmations).toEqual([]);
    expect(states).toEqual([
      {
        status: "failed",
        title: t("settings.host.daemon.update.offlineTitle"),
        message: t("settings.host.daemon.update.offlineMessage"),
      },
    ]);
  });

  test("a cancelled confirmation installs nothing and shows nothing", async () => {
    const daemon = createFakeDaemon();
    const { attempt, states, confirmations } = createAttempt({
      port: daemon.port,
      confirm: async (input) => {
        confirmations.push(input);
        return false;
      },
    });

    await expect(runDaemonUpdateAttempt(attempt)).resolves.toBe("cancelled");

    expect(confirmations).toEqual([
      {
        title: "Update Host A",
        message: t("settings.host.daemon.update.confirmMessage"),
        confirmLabel: t("settings.host.daemon.update.confirm"),
        cancelLabel: t("common.actions.cancel"),
        destructive: false,
      },
    ]);
    expect(daemon.requestIds).toEqual([]);
    expect(states).toEqual([]);
  });

  test("a confirmation dialog that cannot open is shown as a failed request", async () => {
    const { attempt, states } = createAttempt({
      confirm: async () => {
        throw new Error("dialog unavailable");
      },
    });

    await expect(runDaemonUpdateAttempt(attempt)).resolves.toBe("settled");

    expect(states).toEqual([
      {
        status: "failed",
        title: t("settings.host.daemon.update.requestFailedTitle"),
        message: t("settings.host.daemon.update.dialogFailedMessage"),
      },
    ]);
  });

  test("an owner that unmounts during confirmation does not install", async () => {
    const daemon = createFakeDaemon();
    let active = true;
    const { attempt, states } = createAttempt({
      port: daemon.port,
      isActive: () => active,
      confirm: async () => {
        active = false;
        return true;
      },
    });

    await expect(runDaemonUpdateAttempt(attempt)).resolves.toBe("cancelled");

    expect(daemon.requestIds).toEqual([]);
    expect(states).toEqual([]);
  });

  test("succeeds only after the replacement worker reports the installed version", async () => {
    const daemon = createFakeDaemon();
    const { attempt, states } = createAttempt({ port: daemon.port });

    await expect(runDaemonUpdateAttempt(attempt)).resolves.toBe("settled");

    expect(states).toEqual([
      { status: "updating", phase: t("settings.host.daemon.update.phaseStarting") },
      { status: "updating", phase: t("settings.host.daemon.update.phaseInstalling") },
      { status: "complete", workerVersion: "0.11.1-preview.13" },
    ]);
    expect(daemon.listeners.size).toBe(0);
  });

  test("keeps an actionable failure when installation fails", async () => {
    const daemon = createFakeDaemon(() => ({
      success: false,
      error: "Installation denied",
      newVersion: null,
    }));
    const { attempt, states } = createAttempt({ port: daemon.port });

    await expect(runDaemonUpdateAttempt(attempt)).resolves.toBe("settled");

    expect(states.at(-1)).toEqual({
      status: "failed",
      title: t("settings.host.daemon.update.requestFailedTitle"),
      message: t("settings.host.daemon.update.requestFailedMessage", {
        error: "Installation denied",
      }),
    });
    expect(daemon.listeners.size).toBe(0);
  });
});
