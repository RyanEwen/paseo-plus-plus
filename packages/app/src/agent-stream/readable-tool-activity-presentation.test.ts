import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { createStreamPresentation } from "./presentation";

const timestamp = new Date("2026-01-01T00:00:00.000Z");

function codexCall(
  callId: string,
  detail: ToolCallDetail,
  metadata: Record<string, unknown>,
): ToolCallItem {
  return {
    kind: "tool_call",
    id: `tool-${callId}`,
    timestamp,
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId,
        name: detail.type,
        status: "completed",
        error: null,
        detail,
        metadata,
      },
    },
  };
}

/** One answered turn: a read through the shell, then a three-file patch, then the reply. */
const answeredTurn: StreamItem[] = [
  { kind: "user_message", id: "prompt", text: "Work", timestamp },
  codexCall(
    "read",
    { type: "shell", command: "cat a.ts" },
    { commandActions: [{ type: "read", command: "cat a.ts", name: "a.ts", path: "/work/a.ts" }] },
  ),
  codexCall(
    "patch",
    { type: "edit", filePath: "/work/a.ts", oldString: "x", newString: "y" },
    {
      fileChanges: [
        { path: "/work/a.ts", kind: "add" },
        { path: "/work/b.ts", kind: "update" },
        { path: "/work/c.ts", kind: "delete" },
      ],
    },
  ),
  { kind: "assistant_message", id: "reply", text: "Done", timestamp },
];

const baseInput = {
  head: [],
  transform: undefined,
  expandedTurnHostIds: new Set<string>(),
  isTurnActive: false,
};

describe("readable tool activity in stream presentation", () => {
  it("counts a collapsed turn's operations the same way as its tool-call groups", () => {
    const present = createStreamPresentation();
    const readable = present({
      ...baseInput,
      tail: answeredTurn,
      display: "collapseTurns",
      readableToolActivity: true,
    });
    expect(readable.turns.summaryRowsByHostId.get("prompt")?.tools).toMatchObject({
      readFileCount: 1,
      editedFileCount: 3,
      commandCount: 0,
    });

    const classic = createStreamPresentation()({
      ...baseInput,
      tail: answeredTurn,
      display: "collapseTurns",
    });
    expect(classic.turns.summaryRowsByHostId.get("prompt")?.tools).toMatchObject({
      readFileCount: 0,
      editedFileCount: 1,
      commandCount: 1,
    });
  });

  it("builds readable group counts in the projection and rebuilds them when the preference changes", () => {
    const present = createStreamPresentation();
    const input = {
      ...baseInput,
      tail: answeredTurn.slice(1, 3),
      display: "collapseToolCalls",
    } as const;
    // The run's first call hosts its group row.
    const groupSummary = (result: ReturnType<typeof present>) =>
      result.groupsByHostId.get("tool-read")?.summary;

    expect(groupSummary(present({ ...input, readableToolActivity: true }))).toMatchObject({
      readFileCount: 1,
      editedFileCount: 3,
    });
    expect(groupSummary(present({ ...input, readableToolActivity: false }))).toMatchObject({
      readFileCount: 0,
      editedFileCount: 1,
    });
  });
});
