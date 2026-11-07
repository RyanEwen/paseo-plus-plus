import type { SidebarProjectVisibility } from "@/stores/sidebar-view-store";

/** The Display menu's single Empty projects choice over two profile leaves. */
export type EmptyProjectsChoice = "show" | "group" | "hide";

/** Hiding wins: an unarchived-only view has no empty projects to show or group. */
export function emptyProjectsChoice(
  projectVisibility: SidebarProjectVisibility,
  groupEmptyProjects: boolean,
): EmptyProjectsChoice {
  if (projectVisibility === "unarchived") return "hide";
  return groupEmptyProjects ? "group" : "show";
}

/** The settings sync states in which a selected host accepts sidebar edits. */
const WRITABLE_SYNC_STATUSES: ReadonlySet<string> = new Set(["local", "ready", "offline"]);

export interface PreferenceAvailabilityInput {
  /** A registered settings editing blocker is holding edits. */
  blocked: boolean;
  /** Both mode profiles have been seeded. */
  ready: boolean;
  /** The selected settings host lacks separate sidebar modes. */
  unsupported: boolean;
  canWrite: boolean;
  syncStatus: string;
  /** The last failed save's message, if any. */
  error: string | null;
  /** A save is still in flight. */
  pending: boolean;
}

/**
 * Whether sidebar preferences can be edited, and the reason shown when not. The most specific
 * reason wins: an unsupported host, then unavailable settings, then a pending save, then the last
 * error.
 */
export function resolvePreferenceAvailability(input: PreferenceAvailabilityInput): {
  disabled: boolean;
  reason: string | null;
} {
  const disabled =
    input.blocked ||
    !input.ready ||
    input.unsupported ||
    !input.canWrite ||
    !WRITABLE_SYNC_STATUSES.has(input.syncStatus);
  if (input.unsupported) {
    return { disabled, reason: "Update the settings host to use separate sidebar modes" };
  }
  if (disabled) return { disabled, reason: "Load writable settings before editing" };
  if (input.pending && !input.error) return { disabled, reason: "Saving sidebar preferences" };
  return { disabled, reason: input.error };
}
