import { describe, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ToolHosts } from "../host-operations/index.js";
import { resolveRemoteAttentionRequester } from "./host-wiring.js";

function hostsAnswering(fetchAgent: () => Promise<unknown>): () => ToolHosts {
  const client = { fetchAgent } as unknown as DaemonClient;
  return () => ({
    directory: async () => {
      throw new Error("This test addresses the host directly");
    },
    use: async (_serverId, action) => action(client),
  });
}

describe("resolveRemoteAttentionRequester", () => {
  test.each([
    { name: "a live requester", answer: { agent: { archivedAt: null } }, expected: "available" },
    {
      name: "an archived requester",
      answer: { agent: { archivedAt: "2026-11-07T00:00:00.000Z" } },
      expected: "missing",
    },
    { name: "a deleted requester", answer: null, expected: "missing" },
  ])("reports $name from its own host", async ({ answer, expected }) => {
    await expect(
      resolveRemoteAttentionRequester(
        { agentId: "requester", serverId: "remote" },
        hostsAnswering(async () => answer),
      ),
    ).resolves.toBe(expected);
  });

  test("treats an unreachable host as unknown, not as loss", async () => {
    await expect(
      resolveRemoteAttentionRequester(
        { agentId: "requester", serverId: "remote" },
        hostsAnswering(async () => {
          throw new Error("Route closed");
        }),
      ),
    ).resolves.toBe("unknown");
  });
});
