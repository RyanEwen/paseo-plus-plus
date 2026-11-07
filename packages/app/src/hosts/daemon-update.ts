import type { TFunction } from "i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { HostProfile } from "@/types/host-connection";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";
import { updateDaemonFromSettings } from "@/screens/settings/daemon-lifecycle";

/** What a host update surface shows for one host's update attempt. */
export type DaemonUpdateState =
  | { status: "idle" }
  | { status: "complete"; workerVersion: string }
  | { status: "updating"; phase: string }
  | { status: "failed"; title: string; message: string };

/**
 * How an attempt ended for its caller: the user cancelled, another attempt from the same owner
 * was already running, or the attempt reached a displayed outcome (success or failure).
 */
export type DaemonUpdateOutcome = "cancelled" | "duplicate" | "settled";

type DaemonUpdatePhase = "starting" | "downloading" | "installing" | "complete";
type DaemonUpdateDeps = Parameters<typeof updateDaemonFromSettings>[1];

/** The daemon operations one update attempt needs; tests substitute a fake. */
export interface DaemonUpdatePort {
  /** Install the update for `requestId`; resolves with the daemon's install result. */
  updateDaemon: (requestId: string) => ReturnType<DaemonUpdateDeps["updateDaemon"]>;
  /** Read the current worker identity, used to confirm the replacement worker. */
  getStatus: DaemonUpdateDeps["getStatus"];
  /** Observe install progress for every request; returns the unsubscribe function. */
  subscribeProgress: (
    listener: (progress: { requestId: string; phase: DaemonUpdatePhase }) => void,
  ) => () => void;
}

/** Adapt a connected daemon client to the update port. */
export function createDaemonUpdatePort(client: DaemonClient): DaemonUpdatePort {
  return {
    updateDaemon: (requestId) => client.updateDaemon(requestId),
    getStatus: async () => ({
      ...(await client.getDaemonStatus()),
      serverId: client.getLastServerInfoMessage()?.serverId ?? "",
      version: client.getLastServerInfoMessage()?.version ?? null,
    }),
    subscribeProgress: (listener) =>
      client.on("daemon.update.progress", (message) => listener(message.payload)),
  };
}

export interface DaemonUpdateAttempt {
  host: Pick<HostProfile, "serverId" | "label">;
  /** Null when the host has no client, which reports the host as unavailable. */
  port: DaemonUpdatePort | null;
  isConnected: () => boolean;
  confirm: (input: ConfirmDialogInput) => Promise<boolean>;
  t: TFunction;
  /** Receives every state change the surface should show. */
  onState: (state: DaemonUpdateState) => void;
  /** False once the owning surface unmounts; later outcomes are no longer shown. */
  isActive: () => boolean;
}

/**
 * Run one confirmed host update: confirmation, install progress, and verification that the
 * replacement worker reports the installed version. Installation acknowledgement alone never
 * counts as success. Failures become a `failed` state rather than a rejection.
 */
export async function runDaemonUpdateAttempt(
  attempt: DaemonUpdateAttempt,
): Promise<DaemonUpdateOutcome> {
  const { port, t, onState } = attempt;

  // Report a missing or offline host without asking for confirmation.
  if (!port) {
    onState({
      status: "failed",
      title: t("settings.host.daemon.update.unavailableTitle"),
      message: t("settings.host.daemon.update.unavailableMessage"),
    });
    return "settled";
  }
  if (!attempt.isConnected()) {
    onState({
      status: "failed",
      title: t("settings.host.daemon.update.offlineTitle"),
      message: t("settings.host.daemon.update.offlineMessage"),
    });
    return "settled";
  }

  const confirmation = await confirmUpdate(attempt);
  if (confirmation === "dialog-failed") {
    if (attempt.isActive()) {
      onState({
        status: "failed",
        title: t("settings.host.daemon.update.requestFailedTitle"),
        message: t("settings.host.daemon.update.dialogFailedMessage"),
      });
    }
    return "settled";
  }
  if (confirmation === "cancelled" || !attempt.isActive()) {
    return "cancelled";
  }

  await runVerifiedUpdate(attempt, port);
  return "settled";
}

/** Ask the user to confirm; a dialog that cannot open is reported separately from a cancel. */
async function confirmUpdate(
  attempt: DaemonUpdateAttempt,
): Promise<"confirmed" | "cancelled" | "dialog-failed"> {
  const { t } = attempt;
  try {
    const confirmed = await attempt.confirm({
      title: t("settings.host.daemon.update.confirmTitle", { name: attempt.host.label }),
      message: t("settings.host.daemon.update.confirmMessage"),
      confirmLabel: t("settings.host.daemon.update.confirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: false,
    });
    return confirmed ? "confirmed" : "cancelled";
  } catch {
    return "dialog-failed";
  }
}

/** Install with progress, then wait for the replacement worker to report the new version. */
async function runVerifiedUpdate(attempt: DaemonUpdateAttempt, port: DaemonUpdatePort) {
  const { host, t, onState } = attempt;
  // Unique per attempt: the daemon answers a concurrent update with an rpc_error matched by
  // request ID alone, which would otherwise reject every surface's pending update for this host.
  const requestId = `daemon_update_${host.serverId}_${crypto.randomUUID()}`;
  const progressLabels: Record<DaemonUpdatePhase, string> = {
    starting: t("settings.host.daemon.update.phaseStarting"),
    downloading: t("settings.host.daemon.update.phaseDownloading"),
    installing: t("settings.host.daemon.update.phaseInstalling"),
    complete: t("settings.host.daemon.update.phaseComplete"),
  };

  onState({ status: "updating", phase: progressLabels.starting });
  const unsubscribe = port.subscribeProgress((progress) => {
    if (progress.requestId !== requestId || !attempt.isActive()) return;
    onState({ status: "updating", phase: progressLabels[progress.phase] });
  });

  try {
    const { workerVersion } = await updateDaemonFromSettings(host.serverId, {
      updateDaemon: () => port.updateDaemon(requestId),
      getStatus: port.getStatus,
    });
    if (attempt.isActive()) {
      onState({ status: "complete", workerVersion });
    }
  } catch (error) {
    if (attempt.isActive()) {
      onState({
        status: "failed",
        title: t("settings.host.daemon.update.requestFailedTitle"),
        message: t("settings.host.daemon.update.requestFailedMessage", {
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      });
    }
  } finally {
    unsubscribe();
  }
}
