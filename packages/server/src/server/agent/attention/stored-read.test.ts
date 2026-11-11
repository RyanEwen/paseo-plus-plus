import { describe, expect, test } from "vitest";
import type { StoredAgentRecord } from "../agent-storage.js";
import { clearStoredAttentionEvent } from "./stored-read.js";

function storedRecord(overrides: Partial<StoredAgentRecord>): StoredAgentRecord {
  const now = "2026-11-07T00:00:00.000Z";
  return {
    id: "stored-agent",
    provider: "codex",
    cwd: "/tmp/stored-project",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastUserMessageAt: null,
    title: "Stored agent",
    labels: {},
    lastStatus: "idle",
    lastModeId: null,
    config: null,
    persistence: null,
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: now,
    ...overrides,
  };
}

describe("clearStoredAttentionEvent", () => {
  test("clears the event and its reason", () => {
    const cleared = clearStoredAttentionEvent(
      storedRecord({ attentionMessage: "Pick an account", humanAttentionRequired: true }),
    );
    expect(cleared).toMatchObject({
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      attentionMessage: null,
      humanAttentionRequired: false,
    });
  });

  test("leaves an unknown audience unknown", () => {
    expect(clearStoredAttentionEvent(storedRecord({})).humanAttentionRequired).toBeUndefined();
  });

  test("keeps a still-authoritative error visible after the read", () => {
    const cleared = clearStoredAttentionEvent(
      storedRecord({ lastStatus: "error", humanAttentionRequired: true }),
    );
    expect(cleared.humanAttentionRequired).toBe(true);
  });
});
