import type { DaemonUpdateOutcome, DaemonUpdateState } from "@/hosts/daemon-update";
import type { HostProfile } from "@/types/host-connection";

/** Which host's update the sidebar presents, and whether the user hid its progress. */
export interface HostUpdatePresentation {
  host: HostProfile | null;
  /** An attempt is running, from the Update press until its outcome. */
  busy: boolean;
  /** The user closed the progress sheet while the update continues. */
  dismissed: boolean;
}

export type HostUpdatePresentationEvent =
  | { type: "start"; host: HostProfile }
  | { type: "finished"; outcome: DaemonUpdateOutcome }
  | { type: "dismiss" }
  | { type: "close" };

export const CLOSED_HOST_UPDATE: HostUpdatePresentation = {
  host: null,
  busy: false,
  dismissed: false,
};

/**
 * One attempt at a time. A cancelled attempt closes the sheet; a settled one stays presented
 * until the user closes it. Dismissing hides progress without stopping the update.
 */
export function reduceHostUpdatePresentation(
  state: HostUpdatePresentation,
  event: HostUpdatePresentationEvent,
): HostUpdatePresentation {
  switch (event.type) {
    case "start":
      if (state.busy) return state;
      return { host: event.host, busy: true, dismissed: false };
    case "finished":
      if (event.outcome === "settled") return { ...state, busy: false };
      return CLOSED_HOST_UPDATE;
    case "dismiss":
      return { ...state, dismissed: true };
    case "close":
      return { ...state, host: null };
  }
}

/** The sheet shows a presented attempt once it has something to show and was not dismissed. */
export function isHostUpdateSheetVisible(
  presentation: HostUpdatePresentation,
  status: DaemonUpdateState["status"],
): boolean {
  return presentation.host !== null && !presentation.dismissed && status !== "idle";
}
