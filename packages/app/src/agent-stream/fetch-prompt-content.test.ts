import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, it, vi } from "vitest";
import { fetchPromptContent } from "./fetch-prompt-content";

it("reads a complete indexed prompt with one entry and preserves canonical text", async () => {
  const text = `Long prompt\n${"  Original whitespace.\n".repeat(60)}END`;
  const fetchAgentTimeline = vi.fn().mockResolvedValue({
    epoch: "epoch",
    reset: false,
    staleCursor: false,
    error: null,
    entries: [
      {
        provider: "mock",
        item: { type: "user_message", text, messageId: "prompt" },
        timestamp: "2026-10-12T00:00:00.000Z",
        seqStart: 0,
        seqEnd: 0,
      },
    ],
  });
  const client = { fetchAgentTimeline } as unknown as DaemonClient;
  const result = await fetchPromptContent(client, "agent", "epoch", 0);
  expect(fetchAgentTimeline).toHaveBeenCalledWith("agent", {
    direction: "before",
    cursor: { epoch: "epoch", seq: 1 },
    limit: 1,
    projection: "projected",
  });
  expect(result.text).toBe(text);
  expect(result.timelineCursor).toEqual({ epoch: "epoch", seq: 0 });
  fetchAgentTimeline.mockResolvedValue({ epoch: "changed", error: null, entries: [] });
  await expect(fetchPromptContent(client, "agent", "epoch", 0)).rejects.toThrow("unavailable");
});
