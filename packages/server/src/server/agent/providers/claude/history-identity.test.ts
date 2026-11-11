import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import type { ClaudeInitialHistoryContext } from "../../provider-history/claude-identity-types.js";
import { ClaudeHistoryIdentity, type ClaudeHistoryIdentityHost } from "./history-identity.js";

const storage = { kind: "configured-home" as const, provider: "claude" as const, home: "/profile" };

function host(): ClaudeHistoryIdentityHost {
  return {
    isClosed: () => false,
    currentQuery: () => null,
    ownsQuery: () => true,
    claudeSessionId: () => null,
    messageSessionId: () => "",
    sessionMetadata: () => ({}),
    describePersistence: () => null,
    resolveHistoryPath: async () => null,
    harnessEnvironment: () => ({}),
    adoptIdentity: () => {},
  };
}

function initialContext(): ClaudeInitialHistoryContext {
  return { owner: {}, admit: async () => {}, release: () => {}, commit: async () => {} };
}

const partial = { type: "stream_event" } as unknown as SDKMessage;
const init = { type: "system", subtype: "init" } as unknown as SDKMessage;

describe("Claude history identity", () => {
  test("refuses a bound profile route for another provider", () => {
    expect(
      () =>
        new ClaudeHistoryIdentity(host(), {
          storage: { kind: "configured-home", provider: "codex", home: "/a", sqliteHome: "/b" },
        }),
    ).toThrow("Configured provider history cannot use this route: bound-provider-conflict");
  });

  test("holds messages until the root init, then releases them in order", () => {
    const identity = new ClaudeHistoryIdentity(host(), {
      storage,
      initialHistory: initialContext(),
    });
    expect(identity.awaitingIdentity).toBe(true);
    expect(identity.bufferUntilInit(partial, null)).toBe(true);
    expect(identity.bufferUntilInit(init, "subagent-tool")).toBe(true);
    expect(identity.bufferUntilInit(init, null)).toBe(false);
    expect(identity.drainPendingMessages()).toEqual([partial, init]);
    expect(identity.drainPendingMessages()).toEqual([]);
  });

  test("refuses more held messages than an acknowledgment can trail", () => {
    const identity = new ClaudeHistoryIdentity(host(), {
      storage,
      initialHistory: initialContext(),
    });
    for (let index = 0; index < 100; index += 1) identity.bufferUntilInit(partial, null);
    expect(() => identity.bufferUntilInit(partial, null)).toThrow(
      "Configured provider history cannot use this route: identity-acknowledgment-limit",
    );
  });

  test("refuses session-switching text commands only in a bound chat", () => {
    const bound = new ClaudeHistoryIdentity(host(), { storage });
    expect(() => bound.assertPrompt("  /clear now")).toThrow(
      "session-switch-command-use-managed-rewind",
    );
    expect(() => bound.assertPrompt("/compact")).not.toThrow();
    expect(() => new ClaudeHistoryIdentity(host(), {}).assertPrompt("/clear")).not.toThrow();
  });

  test("refuses every prompt after a failed adoption", () => {
    const identity = new ClaudeHistoryIdentity(host(), { storage });
    identity.adoptionFailed = true;
    expect(() => identity.assertPrompt("hello")).toThrow("committed-identity-reload-required");
  });

  test("refuses an extraArgs change on a bound chat", () => {
    const bound = new ClaudeHistoryIdentity(host(), { storage });
    expect(() => bound.assertOptionsPatch({ extraArgs: { resume: "other" } }, {})).toThrow(
      "Configured provider history cannot use this route: unresolved-command-selectors",
    );
    expect(() => bound.assertOptionsPatch({ fast_mode: true }, {})).not.toThrow();
    expect(() => bound.assertOptionsPatch({ extraArgs: null }, {})).not.toThrow();
    const shared = new ClaudeHistoryIdentity(host(), {});
    expect(() => shared.assertOptionsPatch({ extraArgs: { resume: "other" } }, {})).not.toThrow();
  });
});
