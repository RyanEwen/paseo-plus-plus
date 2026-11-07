import type { TFunction } from "i18next";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { stripCwdPrefix } from "@getpaseo/protocol/path-utils";
import {
  describeToolActivity,
  parseFileChanges,
  type ToolActivity,
  type ToolActivityKind,
} from "@getpaseo/protocol/tool-call-activity";
import type { ToolCallDisplayInput } from "@/utils/tool-call-display";

/**
 * How a row's operations are named: one activity kind, "files" for a mixed or generic batch of
 * file changes, or "activity" for any other mix.
 */
export type ActivityDisplayKind = Exclude<ToolActivityKind, "change"> | "files" | "activity";

/** Localized row chrome for readable tool activity. */
export interface ActivityDisplay {
  displayName: string;
  /** Distinct targets, with the working directory removed from paths. */
  summary: string | undefined;
  kind: ActivityDisplayKind;
}

/** The parts of a tool call the activity display reads. */
export type ActivityDisplayInput = Pick<
  ToolCallDisplayInput,
  "agentMessage" | "status" | "detail" | "metadata" | "cwd"
>;

const FILE_OPERATION_KINDS: ReadonlySet<ToolActivityKind> = new Set([
  "create",
  "edit",
  "write",
  "delete",
  "change",
]);

/** Kinds whose target is a filesystem path, shown relative to the working directory. */
const PATH_TARGET_KINDS: ReadonlySet<ToolActivityKind> = new Set([
  "read",
  "edit",
  "write",
  "create",
  "delete",
  "change",
  "list",
]);

/** Name one row's operations: a shared kind, a batch of file changes, or a generic mix. */
function displayKindFor(activities: readonly ToolActivity[]): ActivityDisplayKind {
  const firstKind = activities[0].kind;
  const isHomogeneous = activities.every((activity) => activity.kind === firstKind);
  const isFileBatch = activities.every((activity) => FILE_OPERATION_KINDS.has(activity.kind));
  if (isHomogeneous) {
    // A generic change cannot be named more precisely than a change to files.
    return firstKind === "change" ? "files" : firstKind;
  }
  if (isFileBatch) {
    return "files";
  }
  return "activity";
}

/** The label state for a call's status; failed and canceled calls name what they attempted. */
function labelStateFor(status: ActivityDisplayInput["status"]): "intent" | "running" | "completed" {
  if (status === "completed") return "completed";
  if (status === "running") return "running";
  return "intent";
}

function displayNameFor(
  kind: ActivityDisplayKind,
  status: ActivityDisplayInput["status"],
  t: TFunction,
): string {
  const action = t(`toolActivity.${kind}.${labelStateFor(status)}`);
  if (status === "failed" || status === "canceled") {
    return t(`toolActivity.${status}`, { action });
  }
  return action;
}

/** Distinct targets in order, with paths shown relative to the working directory. */
function summaryFor(
  activities: readonly ToolActivity[],
  cwd: string | undefined,
): string | undefined {
  const targets = activities.flatMap((activity) => {
    if (!activity.target) return [];
    if (PATH_TARGET_KINDS.has(activity.kind)) return [stripCwdPrefix(activity.target, cwd)];
    return [activity.target];
  });
  const summary = [...new Set(targets)].join(", ");
  return summary || undefined;
}

/**
 * Derive localized row chrome only; the original details remain the copy and expand source.
 * Returns undefined for Paseo messages and for details no activity describes, which keep their
 * classic labels.
 */
export function buildActivityDisplay(
  input: ActivityDisplayInput,
  t: TFunction,
): ActivityDisplay | undefined {
  if (input.agentMessage) return undefined;
  const activities = describeToolActivity(input);
  if (activities.length === 0) return undefined;
  const kind = displayKindFor(activities);
  return {
    displayName: displayNameFor(kind, input.status, t),
    summary: summaryFor(activities, input.cwd),
    kind,
  };
}

/**
 * A representative canonical detail per readable kind, handed to the tool-call icon resolver so
 * a shell read or search shows the same icon as a provider's own read or search. The resolver's
 * name rules still run first; these details are never rendered.
 */
const ACTIVITY_ICON_DETAILS: Partial<Record<ActivityDisplayKind, ToolCallDetail>> = {
  read: { type: "read", filePath: "" },
  list: { type: "read", filePath: "" },
  files: { type: "edit", filePath: "" },
  search: { type: "search", query: "" },
};

/** The detail the icon resolver should see for a row; the source detail when no kind applies. */
export function activityIconDetail(
  source: ToolCallDetail | undefined,
  kind: ActivityDisplayKind | undefined,
): ToolCallDetail | undefined {
  return (kind && ACTIVITY_ICON_DETAILS[kind]) ?? source;
}

/**
 * The detail to expand for a call: a Codex patch batch of two or more files is listed in full,
 * so files after the first canonical edit stay inspectable. Applies in both label modes, and
 * never to Paseo messages.
 */
export function detailWithFileBatch(
  source: ToolCallDetail | undefined,
  input: { agentMessage?: unknown; metadata?: Record<string, unknown> },
): ToolCallDetail | undefined {
  if (input.agentMessage) return source;
  const files = parseFileChanges(input.metadata?.fileChanges);
  if (!files || files.length < 2) return source;
  return {
    type: "unknown",
    input: { files: files.map(({ path, kind }) => ({ path, kind })) },
    output: { files },
  };
}
