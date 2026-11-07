import { describe, expect, test, vi } from "vitest";
import { dispatchWithAttentionRejection } from "./dispatch.js";

const admissions = [{ kind: "human" as const, requestId: "human-request" }];

describe("dispatchWithAttentionRejection", () => {
  test("rethrows the dispatch failure when recording the rejection also fails", async () => {
    const dispatchFailure = new Error("Provider refused the prompt");
    const logged: unknown[] = [];

    await expect(
      dispatchWithAttentionRejection({
        agentManager: {
          recordAttentionRejection: async () => {
            throw new Error("Agent storage is unavailable");
          },
        },
        logger: { error: (detail: unknown) => logged.push(detail) },
        recipientId: "recipient",
        admissions,
        dispatch: async () => {
          throw dispatchFailure;
        },
      }),
    ).rejects.toBe(dispatchFailure);
    expect(logged).toEqual([
      { err: new Error("Agent storage is unavailable"), agentId: "recipient" },
    ]);
  });

  test("records the dispatch failure against the batch admissions", async () => {
    const recordAttentionRejection = vi.fn(async () => {});

    await expect(
      dispatchWithAttentionRejection({
        agentManager: { recordAttentionRejection },
        logger: { error: () => {} },
        recipientId: "recipient",
        admissions,
        dispatch: async () => {
          throw new Error("Provider refused the prompt");
        },
      }),
    ).rejects.toThrow("Provider refused the prompt");
    expect(recordAttentionRejection).toHaveBeenCalledExactlyOnceWith({
      agentId: "recipient",
      admissions,
      error: "Provider refused the prompt",
    });
  });

  test("returns the dispatch result without recording anything", async () => {
    const recordAttentionRejection = vi.fn(async () => {});

    await expect(
      dispatchWithAttentionRejection({
        agentManager: { recordAttentionRejection },
        logger: { error: () => {} },
        recipientId: "recipient",
        admissions,
        dispatch: async () => "turn_started",
      }),
    ).resolves.toBe("turn_started");
    expect(recordAttentionRejection).not.toHaveBeenCalled();
  });
});
