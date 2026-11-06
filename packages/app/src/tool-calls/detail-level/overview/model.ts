import { describeToolActivity, type ToolActivity } from "@getpaseo/protocol/tool-call-activity";
import { getPaseoToolActionLabel } from "@getpaseo/protocol/paseo-tool-presentation/index";
import { isTurnTrigger } from "@/agent-stream/turn-membership";

import { describeToolCall, type GroupableItem, type ToolCallRun } from "../grouping";

const DIRECT_SEARCH_TOOL_SUFFIX_PATTERN = /(?:^|[_.:/])(?:web_search|llm_context)$/;

export interface OverviewSummary {
  thoughtCount: number;
  editedFileCount: number;
  commandCount: number;
  readFileCount: number;
  searchCount: number;
  otherToolCount: number;
  paseoActions: Record<string, number>;
}

export interface OverviewToolCallGroup {
  mode: "overview";
  run: ToolCallRun;
  summary: OverviewSummary;
  isLoading: boolean;
}

function isSearchCall(name: string): boolean {
  return DIRECT_SEARCH_TOOL_SUFFIX_PATTERN.test(name);
}

/** Counts tool calls by what they did, for any summary of a stretch of agent work. */
export function summarizeToolCalls(
  calls: readonly GroupableItem[],
  options: { descriptive?: boolean } = {},
): OverviewSummary {
  const editedFiles = new Set<string>();
  const readFiles = new Set<string>();
  let thoughtCount = 0;
  let commandCount = 0;
  let searchCount = 0;
  let otherToolCount = 0;
  const paseoActions: Record<string, number> = {};

  for (const call of calls) {
    if (call.kind === "thought") {
      thoughtCount += 1;
      continue;
    }
    if (isTurnTrigger(call)) continue;
    const descriptor = describeToolCall(call);
    const normalizedName = descriptor.name.trim().toLowerCase();
    const action = getPaseoToolActionLabel(descriptor.name);
    if (action) {
      paseoActions[action] = (paseoActions[action] ?? 0) + 1;
      continue;
    }
    const activities = describeToolActivity({
      detail: descriptor.detail,
      metadata: options.descriptive ? descriptor.metadata : undefined,
    });
    if (activities.length === 0) {
      if (isSearchCall(normalizedName)) searchCount += 1;
      else otherToolCount += 1;
      continue;
    }
    const counts = countActivities({ activities, callId: call.id, readFiles, editedFiles });
    commandCount += counts.commands;
    searchCount += counts.searches;
    otherToolCount += counts.other;
  }

  return {
    thoughtCount,
    editedFileCount: editedFiles.size,
    commandCount,
    readFileCount: readFiles.size,
    searchCount,
    otherToolCount,
    paseoActions,
  };
}

export function buildOverviewGroup(
  run: ToolCallRun,
  options: { descriptive?: boolean } = {},
): OverviewToolCallGroup {
  const isLoading = run.calls.some((call) => {
    if (call.kind === "thought") return call.status !== "ready";
    const status = describeToolCall(call).status;
    return status === "running" || status === "executing";
  });
  return {
    mode: "overview",
    run,
    isLoading,
    summary: summarizeToolCalls(run.calls, options),
  };
}

/** Count mixed batches by their proven operations and deduplicate file targets. */
function countActivities({
  activities,
  callId,
  readFiles,
  editedFiles,
}: {
  activities: ToolActivity[];
  callId: string;
  readFiles: Set<string>;
  editedFiles: Set<string>;
}) {
  const counts = { commands: 0, searches: 0, other: 0 };
  for (const activity of activities) {
    switch (activity.kind) {
      case "read":
        readFiles.add(activity.target ?? callId);
        break;
      case "edit":
      case "write":
      case "change":
      case "create":
      case "delete":
        editedFiles.add(activity.target ?? callId);
        break;
      case "search":
        counts.searches += 1;
        break;
      case "list":
        counts.other += 1;
        break;
      case "command":
      case "script":
        counts.commands += 1;
        break;
    }
  }
  return counts;
}
