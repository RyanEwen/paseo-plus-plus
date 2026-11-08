import type { ToolCallTimelineItem } from "../agent-sdk-types.js";
import { mapClaudeFailedToolCall } from "./claude/tool-call-mapper.js";
import { mapCodexToolCallFromThreadItem } from "./codex/tool-call-mapper.js";
import { mapOpencodeToolCall } from "./opencode/tool-call-mapper.js";
import { mapToolDetail, parseToolArgs } from "./pi/tool-call-mapper.js";

/**
 * A scripted mock turn for Readable tool activity browser tests. The mock provider emits these
 * calls through the daemon, so their provider metadata reaches the app the way real history does.
 * The browser spec asserts on the same command and output strings.
 */

const SCENE_PROMPT = /emit\s+(?:the\s+)?readable\s+tool\s+activity\s+scene/i;

export const ACTIVITY_READ_COMMAND = "cat src/notifications.ts";
export const ACTIVITY_READ_OUTPUT = "export const notification = 'exact preserved output';";
export const ACTIVITY_OPAQUE_COMMAND = "python - <<'PY'\nprint('opaque script output')\nPY";

/** Whether a prompt's text asks the mock provider for the readable tool activity scene. */
export function requestsToolActivityScene(promptText: string): boolean {
  return SCENE_PROMPT.test(promptText);
}

function mapped(call: ToolCallTimelineItem | null): ToolCallTimelineItem {
  if (!call) throw new Error("Expected canonical provider activity fixture");
  return call;
}

/**
 * Seven calls from the shipped provider mappers: a Codex shell read, a failed Claude edit, a
 * canceled Pi write, an OpenCode search, a three-file Codex patch, a running script and a failed
 * opaque script. Paths sit under `cwd` so the app shows them relative to the workspace.
 */
export function buildToolActivityScene(cwd: string): ToolCallTimelineItem[] {
  return [
    mapped(
      mapCodexToolCallFromThreadItem({
        type: "commandExecution",
        id: "read",
        status: "completed",
        cwd,
        command: ACTIVITY_READ_COMMAND,
        aggregatedOutput: ACTIVITY_READ_OUTPUT,
        exitCode: 0,
        commandActions: [
          {
            type: "read",
            command: ACTIVITY_READ_COMMAND,
            name: "notifications.ts",
            path: `${cwd}/src/notifications.ts`,
          },
        ],
      }),
    ),
    mapped(
      mapClaudeFailedToolCall({
        name: "Edit",
        callId: "failed-edit",
        input: { file_path: "src/failed-edit.ts", old_string: "before", new_string: "after" },
        error: "Edit failed before writing",
      }),
    ),
    {
      type: "tool_call",
      callId: "canceled-write",
      name: "write",
      status: "canceled",
      error: null,
      detail: mapToolDetail(
        parseToolArgs("write", { path: "src/canceled-write.ts", content: "unchanged" }),
        null,
      ),
    },
    mapped(
      mapOpencodeToolCall({
        toolName: "grep",
        callId: "search",
        status: "completed",
        input: { pattern: "notification" },
        output: "src/notifications.ts",
      }),
    ),
    mapped(
      mapCodexToolCallFromThreadItem(
        {
          type: "fileChange",
          id: "multi-patch",
          status: "completed",
          changes: [
            { path: "src/created.ts", kind: { type: "add" }, diff: "+created-file-exact-diff" },
            {
              path: "src/updated.ts",
              kind: { type: "update" },
              diff: "-before\n+updated-file-exact-diff",
            },
            { path: "src/deleted.ts", kind: { type: "delete" }, diff: "deleted-file-exact-diff" },
          ],
        },
        { cwd },
      ),
    ),
    mapped(
      mapCodexToolCallFromThreadItem({
        type: "commandExecution",
        id: "running-script",
        status: "inProgress",
        command: "npm run test",
        cwd,
      }),
    ),
    mapped(
      mapCodexToolCallFromThreadItem({
        type: "commandExecution",
        id: "opaque-failed",
        status: "failed",
        command: ACTIVITY_OPAQUE_COMMAND,
        cwd,
        aggregatedOutput: "opaque script output",
        exitCode: 1,
      }),
    ),
  ];
}
