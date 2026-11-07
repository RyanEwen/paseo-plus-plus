import { describe, expect, test, vi } from "vitest";
import type { ClaudeFreshRewindContext } from "./provider-history/claude-identity-types.js";

import type {
  AgentCapabilityFlags,
  AgentRewindInput,
  AgentPromptInput,
  AgentSession,
  AgentStreamEvent,
  AgentRuntimeInfo,
  SteerActiveTurnOptions,
  SteerResult,
  ImportedTimelineEntry,
} from "./agent-sdk-types.js";
import { wrapSessionProvider } from "./provider-registry.js";

type OptionalAgentSessionMethodName = {
  [K in keyof AgentSession]-?: undefined extends AgentSession[K]
    ? NonNullable<AgentSession[K]> extends (...args: never[]) => unknown
      ? K
      : never
    : never;
}[keyof AgentSession];

const OPTIONAL_AGENT_SESSION_METHOD_NAMES = [
  "steerActiveTurn",
  "listCommands",
  "setModel",
  "setThinkingOption",
  "setFeature",
  "revertConversation",
  "revertFiles",
  "revertBoth",
  "tryHandleOutOfBand",
] as const satisfies readonly OptionalAgentSessionMethodName[];

type MissingOptionalAgentSessionMethod = Exclude<
  OptionalAgentSessionMethodName,
  (typeof OPTIONAL_AGENT_SESSION_METHOD_NAMES)[number]
>;

const _allOptionalAgentSessionMethodsAreCovered: MissingOptionalAgentSessionMethod extends never
  ? true
  : never = true;

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

const RUNTIME_INFO: AgentRuntimeInfo = {
  provider: "claude",
  sessionId: "session-1",
};

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly historyStorage = {
    kind: "unverified",
    provider: "claude",
    home: "/custom/claude-home",
  } as const;
  id = "session-1";
  capabilities = CAPABILITIES;
  initialTimeline: ImportedTimelineEntry[] = [
    { item: { type: "assistant_message", id: "initial", text: "Provider setup" } },
  ];
  readonly steers: Array<{ prompt: AgentPromptInput; options: SteerActiveTurnOptions }> = [];
  readonly features = [];
  readonly recordedCalls: string[] = [];

  async run() {
    this.recordedCalls.push("run");
    return { timeline: [] };
  }

  async startTurn() {
    this.recordedCalls.push("startTurn");
    return { turnId: "turn-1" };
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    this.recordedCalls.push("steerActiveTurn");
    this.steers.push({ prompt, options });
    return { status: "accepted" };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void) {
    this.recordedCalls.push("subscribe");
    return () => {};
  }

  async *streamHistory() {
    this.recordedCalls.push("streamHistory");
    yield* emptyHistory();
  }

  async getRuntimeInfo() {
    this.recordedCalls.push("getRuntimeInfo");
    return RUNTIME_INFO;
  }

  async getAvailableModes() {
    this.recordedCalls.push("getAvailableModes");
    return [];
  }

  async getCurrentMode() {
    this.recordedCalls.push("getCurrentMode");
    return null;
  }

  async setMode(_modeId: string) {
    this.recordedCalls.push("setMode");
  }

  getPendingPermissions() {
    this.recordedCalls.push("getPendingPermissions");
    return [];
  }

  async respondToPermission() {
    this.recordedCalls.push("respondToPermission");
  }

  describePersistence() {
    this.recordedCalls.push("describePersistence");
    return null;
  }

  async interrupt() {
    this.recordedCalls.push("interrupt");
  }

  async close() {
    this.recordedCalls.push("close");
  }

  async listCommands() {
    this.recordedCalls.push("listCommands");
    return [];
  }

  async setModel() {
    this.recordedCalls.push("setModel");
  }

  async setThinkingOption() {
    this.recordedCalls.push("setThinkingOption");
  }

  async setFeature() {
    this.recordedCalls.push("setFeature");
  }

  async revertConversation() {
    this.recordedCalls.push("revertConversation");
  }

  async revertFiles() {
    this.recordedCalls.push("revertFiles");
  }

  async revertBoth() {
    this.recordedCalls.push("revertBoth");
  }

  tryHandleOutOfBand(_prompt: AgentPromptInput) {
    this.recordedCalls.push("tryHandleOutOfBand");
    return {
      run: async () => {
        this.recordedCalls.push("tryHandleOutOfBand.run");
      },
    };
  }
}

async function* emptyHistory(): AsyncGenerator<AgentStreamEvent> {
  for (const event of [] as AgentStreamEvent[]) {
    yield event;
  }
}

describe("wrapSessionProvider", () => {
  test("forwards every optional AgentSession method", async () => {
    const session = new FakeSession();
    const wrapped = wrapSessionProvider("custom-claude", session);

    await wrapped.steerActiveTurn?.("follow-up", { expectedTurnId: "turn-1" });
    await wrapped.listCommands?.();
    await wrapped.setModel?.("sonnet");
    await wrapped.setThinkingOption?.("high");
    await wrapped.setFeature?.("feature-1", true);
    await wrapped.revertConversation?.({ messageId: "message-1" });
    await wrapped.revertFiles?.({ messageId: "message-1" });
    await wrapped.revertBoth?.({ messageId: "message-1" });
    const handler = wrapped.tryHandleOutOfBand?.("/compact");
    await handler?.run({ emit: () => {} });

    expect(session.steers).toEqual([
      { prompt: "follow-up", options: { expectedTurnId: "turn-1" } },
    ]);
    expect(session.recordedCalls).toEqual([
      "steerActiveTurn",
      "listCommands",
      "setModel",
      "setThinkingOption",
      "setFeature",
      "revertConversation",
      "revertFiles",
      "revertBoth",
      "tryHandleOutOfBand",
      "tryHandleOutOfBand.run",
    ]);
  });
  test("keeps provider-owned session values live", () => {
    const session = new FakeSession();
    const wrapped = wrapSessionProvider("custom-claude", session);
    session.id = "session-2";
    session.capabilities = { ...CAPABILITIES, supportsMcpServers: false };
    expect(wrapped.id).toBe("session-2");
    expect(wrapped.capabilities).toEqual(session.capabilities);
    expect(wrapped.initialTimeline).toEqual(session.initialTimeline);
  });

  test("propagates steering failure without interrupting or replacing the turn", async () => {
    const error = new Error("Provider steer transport failed");
    class RejectingSession extends FakeSession {
      override async steerActiveTurn(): Promise<SteerResult> {
        throw error;
      }
    }
    const session = new RejectingSession();
    const wrapped = wrapSessionProvider("custom-claude", session);
    await expect(wrapped.steerActiveTurn!("follow-up", { expectedTurnId: "turn-1" })).rejects.toBe(
      error,
    );
    expect(session.recordedCalls).toEqual([]);
  });

  test("leaves steering unavailable when the provider has no implementation", () => {
    const session: AgentSession = new FakeSession();
    session.steerActiveTurn = undefined;
    expect(wrapSessionProvider("custom-claude", session).steerActiveTurn).toBeUndefined();
  });
});

test("derived providers retain the base adapter's observed unverified storage", () => {
  const inner = new FakeSession();
  const wrapped = wrapSessionProvider("claude-work", inner);
  expect(wrapped.historyStorage).toEqual({
    kind: "unverified",
    provider: "claude",
    home: "/custom/claude-home",
  });
  expect(wrapped.provider).toBe("claude-work");
});

test("derived Claude rewind maps actual handles and preserves invocation context ownership", async () => {
  const storage = {
    kind: "configured-home" as const,
    provider: "claude" as const,
    home: "/fixture/configured",
  };
  let adopted: ClaudeFreshRewindContext | undefined;
  class RewindingSession extends FakeSession {
    override async revertConversation(input: AgentRewindInput) {
      await input.commitClaudeRewind!({
        previous: { provider: "claude", sessionId: "old", nativeHandle: "old" },
        next: { provider: "claude", sessionId: "actual-new", nativeHandle: "actual-new" },
        storage,
        adopt: (context) => {
          adopted = context;
        },
      });
    }
  }
  const wrapped = wrapSessionProvider("claude-work", new RewindingSession());
  const owner = {};
  const commit = vi.fn(async () => {});
  const fresh: ClaudeFreshRewindContext = {
    owner,
    operationId: "operation",
    admit: async () => {},
    release: () => {},
    commit,
  };
  await wrapped.revertConversation!({
    messageId: "target",
    commitClaudeRewind: async (transition) => {
      expect(transition.previous.provider).toBe("claude-work");
      expect(transition.next?.provider).toBe("claude-work");
      expect(transition.storage.provider).toBe("claude");
      transition.adopt(fresh);
    },
  });
  expect(adopted?.owner).toBe(owner);
  await adopted!.commit({
    previous: { provider: "claude", sessionId: "old" },
    next: { provider: "claude", sessionId: "new" },
    storage,
    adopt: () => {},
  });
  expect(commit).toHaveBeenCalledWith(
    expect.objectContaining({ next: expect.objectContaining({ provider: "claude-work" }) }),
  );
});
