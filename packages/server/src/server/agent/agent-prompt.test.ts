import { AgentAttentionObjectives } from "./attention/objectives.js";
import { toAgentPayload } from "./agent-projections.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import { createTestAgentMessages } from "../test-utils/agent-messages.js";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  parseAgentMessage,
  parseAgentMessages,
  formatAgentMessage,
  prepareAgentMessage,
  projectAgentMessages,
} from "./agent-messages/index.js";
import { expect, it, test, vi } from "vitest";
import pino, { type Logger } from "pino";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import {
  setupFinishNotification,
  setupFinishWait,
  waitForAgentRunStartWithTimeout,
} from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

interface CapturedLogger {
  logger: Logger;
  records: Array<Record<string, unknown>>;
  nextRecord: Promise<void>;
}

function createCapturedLogger(): CapturedLogger {
  const records: Array<Record<string, unknown>> = [];
  let resolveNextRecord!: () => void;
  const nextRecord = new Promise<void>((resolve) => {
    resolveNextRecord = resolve;
  });
  const logger = pino(
    { level: "error" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
        resolveNextRecord();
      },
    },
  );
  return { logger, records, nextRecord };
}

interface FinishNotificationScenarioOptions {
  childLastAssistantMessage?: string | null;
  childParentAgentId?: string | null;
  requireParentOwnership?: boolean;
  parentPromptError?: Error;
  logger?: Logger;
}

interface FinishNotificationScenario {
  startWatchingChild(): void;
  requestChildPermission(requestId?: string): void;
  resolveChildPermission(requestId?: string): void;
  resolveChildPermissionFromState(requestId?: string): void;
  resolveChildPermissionWhileIdle(requestId?: string): void;
  finishChild(): void;
  finishChildAndReadParentPrompt(): Promise<string>;
  closeChildAndReadParentPrompt(): Promise<string>;
  parentPrompts(): string[];
  steerAttemptCount(): number;
  wasParentPrompted(): boolean;
}

function createFinishNotificationScenario(
  options?: FinishNotificationScenarioOptions,
): FinishNotificationScenario {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  let resolveParentPrompt: ((prompt: string) => void) | null = null;
  let parentPrompted = false;
  let steerAttemptCount = 0;
  const parentPrompts: string[] = [];

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const agentManager = new AgentManager({ clients: {}, logger: createTestLogger() });
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === "child-agent") {
      return childAgent;
    }
    if (agentId === "caller-agent") {
      return callerAgent;
    }
    return null;
  });
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscriber = callback;
    return () => {
      subscriber = null;
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return options?.childLastAssistantMessage ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => Boolean(options?.parentPromptError));
  Reflect.set(agentManager, "steerOrReplaceActiveTurn", async () => {
    steerAttemptCount += 1;
    return { status: "inactive" };
  });
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    parentPrompted = true;
    parentPrompts.push(prompt);
    resolveParentPrompt?.(prompt);
    return (async function* noop() {})();
  });
  Reflect.set(agentManager, "replaceAgentRun", async (_agentId: string, prompt: string) => {
    resolveParentPrompt?.(prompt);
    throw options?.parentPromptError;
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      const parentAgentId =
        options?.childParentAgentId === undefined ? "caller-agent" : options.childParentAgentId;
      return {
        title: "Child Agent",
        labels: parentAgentId ? { "paseo.parent-agent-id": parentAgentId } : {},
      };
    }
    return null;
  });

  return {
    startWatchingChild() {
      setupFinishNotification({
        agentMessages: createTestAgentMessages({
          agentManager,
          agentStorage,
          logger: options?.logger ?? createTestLogger(),
        }),
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: options?.requireParentOwnership,
        logger: options?.logger ?? createTestLogger(),
      });
    },
    requestChildPermission(requestId = "permission-1") {
      childAgent.lifecycle = "running";
      childAgent.pendingPermissions.set(requestId, {
        id: requestId,
        provider: "claude",
        kind: "tool",
        name: "Run command",
        description: "Write the QA sentinel",
        input: {
          file_path: "/tmp/permission-qa.txt",
          content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
        },
      });
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_requested",
          provider: "codex",
          request: childAgent.pendingPermissions.get(requestId)!,
        },
      });
    },
    resolveChildPermission(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    resolveChildPermissionFromState(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber?.({ type: "agent_state", agent: childAgent });
    },
    resolveChildPermissionWhileIdle(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      childAgent.lifecycle = "idle";
      subscriber?.({ type: "agent_state", agent: childAgent });
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    finishChild() {
      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "idle";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: { type: "turn_completed", provider: "codex" },
      });
    },
    async finishChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });
      this.finishChild();

      return parentPrompt;
    },
    async closeChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });

      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "closed";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      return parentPrompt;
    },
    parentPrompts() {
      return parentPrompts;
    },
    steerAttemptCount() {
      return steerAttemptCount;
    },
    wasParentPrompted() {
      return parentPrompted;
    },
  };
}

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("finish notifications tell the parent the child's last assistant message", async () => {
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: "Implemented the cleanup and all checks pass.",
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parseAgentMessage(parentPrompt)).toEqual({
    id: expect.any(String),
    source: {
      kind: "agent-notification",
      agentId: "child-agent",
      title: "Child Agent",
      event: "finished",
    },
    text: "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>",
  });
  expect(scenario.steerAttemptCount()).toBe(1);
});

test("finish notifications truncate oversized child responses", async () => {
  const included = "x".repeat(4000);
  const omitted = "TAIL-MARKER".repeat(50);
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: included + omitted,
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain(included);
  expect(parentPrompt).toContain(
    `[truncated ${omitted.length} chars; use get_agent_activity for the full response]`,
  );
  expect(parentPrompt).not.toContain("TAIL-MARKER");
});

test("closing a watched child notifies the caller", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  const parentPrompt = await scenario.closeChildAndReadParentPrompt();

  expect(parseAgentMessage(parentPrompt)).toEqual({
    id: expect.any(String),
    source: {
      kind: "agent-notification",
      agentId: "child-agent",
      title: "Child Agent",
      event: "closed",
    },
    text: "Agent child-agent (Child Agent) was closed.",
  });
});

test("finish notifications survive permission responses", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(1);
  });
  expect(scenario.parentPrompts()[0]).toContain("needs permission.");
  const permissionPayload = parseAgentMessage(scenario.parentPrompts()[0])!.text.match(
    /<permission-request>\n([\s\S]+?)\n<\/permission-request>/,
  )?.[1];
  expect(permissionPayload).toBeDefined();
  expect(JSON.parse(permissionPayload!)).toEqual({
    agentId: "child-agent",
    requestId: "permission-1",
    request: {
      id: "permission-1",
      provider: "claude",
      kind: "tool",
      name: "Run command",
      description: "Write the QA sentinel",
      input: {
        file_path: "/tmp/permission-qa.txt",
        content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
      },
    },
  });

  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(2);
  });
  expect(scenario.parentPrompts()[1]).toContain("finished.");
});

test("an idle permission resolution waits for the resumed run to finish", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

  scenario.resolveChildPermissionWhileIdle();
  scenario.requestChildPermission("permission-2");
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(scenario.parentPrompts().every((prompt) => prompt.includes("needs permission."))).toBe(
    true,
  );

  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(scenario.parentPrompts()[2]).toContain("finished.");
});

test("finish notifications report every concurrently pending permission", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission("permission-1");
  scenario.requestChildPermission("permission-2");

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
  expect(
    scenario
      .parentPrompts()
      .flatMap((prompt) => parseAgentMessages(prompt)!)
      .map((message) => {
        const payload = message.text.match(
          /<permission-request>\n([\s\S]+?)\n<\/permission-request>/,
        )?.[1];
        return JSON.parse(payload!).requestId;
      }),
  ).toEqual(["permission-1", "permission-2"]);

  scenario.resolveChildPermission("permission-1");
  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(scenario.parentPrompts()[1]).toContain("finished.");
});

test("finish notifications survive repeated permission cycles", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
  scenario.resolveChildPermissionFromState();

  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(
    scenario.parentPrompts().map((prompt) => prompt.match(/(needs permission|finished)\./)?.[1]),
  ).toEqual(["needs permission", "needs permission", "finished"]);
});

test("detaching a child ends its parent-owned finish notification", async () => {
  const scenario = createFinishNotificationScenario({
    childParentAgentId: null,
    requireParentOwnership: true,
  });
  scenario.startWatchingChild();
  scenario.finishChild();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scenario.wasParentPrompted()).toBe(false);
});

test("follow-up finish notifications do not require a parent relationship", async () => {
  const scenario = createFinishNotificationScenario({ childParentAgentId: "another-agent" });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain("Agent child-agent (Child Agent) finished.");
});

test("finish notifications log a rejected parent prompt without an unhandled rejection", async () => {
  const captured = createCapturedLogger();
  const scenario = createFinishNotificationScenario({
    parentPromptError: new Error("parent provider rejected replacement"),
    logger: captured.logger,
  });

  scenario.startWatchingChild();
  await scenario.finishChildAndReadParentPrompt();
  await captured.nextRecord;

  expect(captured.records).toEqual([
    expect.objectContaining({
      msg: "Agent message batch dispatch failed",
      agentId: "caller-agent",
      messageIds: [expect.any(String)],
      err: expect.objectContaining({ message: "parent provider rejected replacement" }),
    }),
  ]);
});

it("does not notify archived callers", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());

  const agentManager = new AgentManager({ clients: {}, logger: createTestLogger() });
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === "child-agent") {
        return childAgent;
      }
      if (agentId === "caller-agent") {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);
  Reflect.set(agentManager, "replaceAgentRun", replaceAgentRunSpy);

  const agentStorageGetSpy = vi.fn(async (agentId: string) =>
    agentId === "caller-agent" ? { archivedAt: "2024-01-01" } : null,
  );
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", agentStorageGetSpy);

  setupFinishNotification({
    agentMessages: createTestAgentMessages({
      agentManager,
      agentStorage,
      logger: createTestLogger(),
    }),
    agentManager,
    agentStorage,
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });
  subscriber?.({
    type: "agent_stream",
    agentId: "child-agent",
    event: { type: "turn_completed", provider: "codex" },
  });

  await vi.waitFor(() => {
    expect(agentStorageGetSpy).toHaveBeenCalledWith("caller-agent");
  });

  expect(streamAgentSpy).not.toHaveBeenCalled();
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
});

// Deliberately independent literals rather than the production constants these tests
// guard: deriving the boundaries from AGENT_RUN_START_TIMEOUT_MS would keep the tests
// green if that constant were shortened back under a provider's startup budget.
const EXPECTED_RUN_START_BUDGET_MS = 60_000;
// The slowest provider startup budget the run-start wait has to sit outside of today
// (OpenCode's OPENCODE_SERVER_STARTUP_TIMEOUT_MS).
const SLOWEST_PROVIDER_STARTUP_BUDGET_MS = 30_000;

const RUN_START_TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * Provider session whose turn start is held open for a configurable span, so the real
 * AgentManager run-state transition (pendingRun.started -> lifecycle "running" ->
 * agent_state) is what the run-start wait observes. `startDelayMs: null` never starts.
 */
class SlowStartAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private releaseStartTurn!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseStartTurn = resolve;
  });

  constructor(private readonly startDelayMs: number | null) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  /** Teardown hook so a never-starting turn cannot wedge the suite. */
  release(): void {
    this.releaseStartTurn();
  }

  async startTurn(): Promise<{ turnId: string }> {
    await new Promise<void>((resolve) => {
      if (this.startDelayMs !== null) {
        setTimeout(resolve, this.startDelayMs);
      }
      void this.released.then(resolve);
    });
    const turnId = "turn-1";
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class SlowStartAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly sessions: SlowStartAgentSession[] = [];

  constructor(private readonly startDelayMs: number | null) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new SlowStartAgentSession(this.startDelayMs);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}

/**
 * Real AgentManager driving a real agent, so the run-start wait exercises the production
 * run-state and agent_state subscription path rather than a replaced method.
 */
async function createRunStartScenario(startDelayMs: number | null): Promise<{
  agentManager: AgentManager;
  agentId: string;
  startRun: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-run-start-budget-"));
  const client = new SlowStartAgentClient(startDelayMs);
  const agentManager = new AgentManager({
    clients: { codex: client },
    logger: createTestLogger(),
  });
  const snapshot = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  let drained: Promise<void> = Promise.resolve();
  return {
    agentManager,
    agentId: snapshot.id,
    // streamAgent registers the pending run synchronously, so the wait always observes it.
    startRun: async () => {
      const run = agentManager.streamAgent(snapshot.id, "start the run");
      drained = (async () => {
        for await (const _event of run) {
          // Drain whatever the turn produces.
        }
      })().catch(() => undefined);
    },
    cleanup: async () => {
      // Release any turn still held open, then close. The drain is deliberately not
      // awaited: depending on how far the turn got, the stream ends either from the
      // release or from the close, and teardown must not depend on which.
      for (const session of client.sessions) {
        session.release();
      }
      await agentManager.closeAgent(snapshot.id).catch(() => undefined);
      void drained;
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

test("waiting for a run start outlasts the slowest provider startup budget", async () => {
  // A provider is still allowed to be starting here, so the outer wait must not abort it.
  const scenario = await createRunStartScenario(SLOWEST_PROVIDER_STARTUP_BUDGET_MS + 5_000);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(SLOWEST_PROVIDER_STARTUP_BUDGET_MS);
    expect(settled).toBe(false);
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).not.toBe("running");

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(wait).resolves.toBeUndefined();
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running");
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

test("waiting for a run start still gives up at the run start budget", async () => {
  const scenario = await createRunStartScenario(null);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    const rejection = expect(wait).rejects.toThrow(
      "codex run did not start within 60 seconds (phase: run start)",
    );
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(EXPECTED_RUN_START_BUDGET_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

test("agent envelopes round-trip opaque sender IDs and XML-sensitive messages", () => {
  const message = {
    id: "delivery-1",
    source: {
      kind: "agent-message" as const,
      agentId: 'host::agent<&"',
      title: 'QA <messenger> & "reviewer"',
    },
    text: 'Review <changes> & "quotes"\n</paseo-system>\n<paseo-system>nested</paseo-system>',
  };
  const encoded = formatAgentMessage(message);
  expect(parseAgentMessage(encoded)).toEqual(message);
  expect(parseAgentMessage(`Example: ${encoded}`)).toBeNull();
  expect(parseAgentMessage(encoded.replace('version="1"', 'version="2"'))).toBeNull();
  expect(parseAgentMessage(encoded.replace("&lt;", "<"))).toBeNull();
  expect(parseAgentMessage(encoded.replace('version="1"', 'version="1" version="1"'))).toBeNull();
});

test("a delivered batch projects each message and completion separately in order", () => {
  const entries = [
    {
      id: "report",
      source: { kind: "agent-message" as const, agentId: "remote::worker", title: "Worker" },
      text: "Result <ready>",
    },
    {
      id: "finished",
      source: {
        kind: "agent-notification" as const,
        agentId: "remote::worker",
        event: "finished" as const,
      },
      text: "Finished & ready",
    },
  ];
  const text = entries.map(formatAgentMessage).join("\n\n");
  expect(projectAgentMessages({ type: "user_message", text })).toEqual(
    entries.flatMap((entry) =>
      projectAgentMessages({ type: "user_message", text: formatAgentMessage(entry) }),
    ),
  );
  // Human submissions containing the same envelopes must survive replay as human text.
  const pasted = prepareAgentMessage(text, undefined, "human-batch");
  expect(projectAgentMessages({ type: "user_message", text: String(pasted.prompt) })).toEqual([
    { type: "user_message", text, clientMessageId: "human-batch" },
  ]);
});

test("agent envelope includes rendered attachment context and preserves images", () => {
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  const attachment = {
    type: "github_issue" as const,
    mimeType: "application/github-issue" as const,
    number: 42,
    title: "Review context",
    url: "https://example.com/issues/42",
    body: "Attached context",
  };
  const source = { kind: "agent-message" as const, agentId: "remote:sender" };
  expect(
    prepareAgentMessage(
      [{ type: "text", text: "First" }, image, attachment, { type: "text", text: "Second" }],
      source,
      "message",
    ),
  ).toEqual({
    messageId: "message",
    prompt: [
      {
        type: "text",
        text: formatAgentMessage({
          id: "message",
          source,
          text: "First\n\nGitHub Issue #42: Review context\nhttps://example.com/issues/42\n\nAttached context\n\nSecond",
        }),
      },
      image,
    ],
  });
});

test("a human pasting an agent envelope stays a human message through provider replay", () => {
  const pasted = formatAgentMessage({
    id: "example",
    source: { kind: "agent-message", agentId: "sender" },
    text: "hello",
  });
  const delivery = prepareAgentMessage(pasted, undefined, "human-submission");
  expect(
    projectAgentMessages({
      type: "user_message",
      text: String(delivery.prompt),
      messageId: "provider-echo",
    })[0],
  ).toEqual({
    type: "user_message",
    text: pasted,
    messageId: "provider-echo",
    clientMessageId: "human-submission",
  });
});

it.each([
  {
    mode: "parented",
    name: "keeps two exact routed request watches so later work cannot discard an earlier result",
  },
  {
    mode: "independent",
    name: "independent routed recipient returns exact outcomes despite parent mismatch",
  },
  {
    mode: "legacy",
    name: "independent routed recipient without correlation retains parent rejection and cannot dispatch",
  },
  {
    mode: "invalid-token",
    name: "independent routed recipient with invalid correlation cannot dispatch",
  },
  {
    mode: "no-outcome",
    name: "independent routed recipient without exact outcome evidence cannot dispatch",
  },
])("$name", async ({ mode }) => {
  const workdir = mkdtempSync(join(tmpdir(), "attention-watch-membership-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const parentPrompts: string[] = [];
  const manager = new AgentManager({
    registry: storage,
    logger,
    clients: createTestAgentClients({
      onStartTurn: (prompt, config) => {
        if (config.title === "Caller")
          parentPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
      },
    }),
  });
  manager.setAttentionHost({ serverId: "origin", resolveRemoteRequester: async () => "unknown" });
  const source = new AgentAttentionObjectives(undefined, "origin");
  source.admit({
    inputs: [
      { kind: "human", requestId: "human-A" },
      { kind: "human", requestId: "human-B" },
    ],
  });
  source.declare("human-A", "waiting");
  source.declare("human-B", "waiting");
  const callerId = randomUUID();
  const childId = randomUUID();
  const peer = { agentId: childId, serverId: "target" };
  const links = ["human-A", "human-B"].map(
    (objectiveId) => source.outgoing({ recipient: peer, objectiveId })?.requesterObjective,
  );
  await manager.createAgent({ provider: "claude", cwd: workdir, title: "Caller" }, callerId, {
    workspaceId: undefined,
    attentionObjectives: source.snapshot(),
  });
  const child = await manager.createAgent(
    { provider: "claude", cwd: workdir, title: "Child" },
    childId,
    {
      workspaceId: undefined,
      labels:
        mode === "parented"
          ? {
              "paseo.parent-agent-id": callerId,
              "paseo.parent-server-id": "origin",
            }
          : undefined,
    },
  );
  const final = toAgentPayload(child, { title: "Child" });
  const delivery = createTestAgentMessages({
    agentManager: manager,
    agentStorage: storage,
    logger,
  });
  const outcomes = [
    Promise.withResolvers<WaitForFinishResult>(),
    Promise.withResolvers<WaitForFinishResult>(),
  ];
  const enqueue = vi.spyOn(delivery, "enqueue");
  const reservations = vi.spyOn(manager, "reserveAttentionCallback");
  const signals: AbortSignal[] = [];
  const acknowledgements: string[] = [];
  const stops: Array<() => void> = [];
  try {
    for (const [index, link] of links.entries()) {
      if (!link) throw new Error("Expected exact request link");
      let first = true;
      stops.push(
        setupFinishWait({
          agentManager: manager,
          agentStorage: storage,
          agentMessages: delivery,
          originServerId: "origin",
          childServerId: "target",
          childAgentId: childId,
          callerAgentId: callerId,
          attention:
            mode === "legacy"
              ? undefined
              : {
                  continuation:
                    mode === "invalid-token" ? { ...link, token: "invalid-token" } : link,
                },
          logger,
          wait: async (signal, query) => {
            if (query?.acknowledgeOutcomeId) acknowledgements.push(query.acknowledgeOutcomeId);
            if (first) {
              first = false;
              signals.push(signal);
              return outcomes[index].promise;
            }
            return {
              status: "idle",
              final,
              error: null,
              lastMessage: null,
              attentionOutcome: null,
            };
          },
          afterPermission: async () => {},
        }),
      );
    }
    for (const index of [1, 0]) {
      const link = links[index];
      if (!link) throw new Error("Expected request link");
      outcomes[index].resolve({
        status: "idle",
        final,
        error: null,
        lastMessage: "Untrusted current message",
        attentionOutcome:
          mode === "no-outcome"
            ? null
            : {
                id: randomUUID(),
                requestId: link.requestId,
                requester: { agentId: callerId, serverId: "origin" },
                acceptedTurnId: `target-${index}`,
                kind: "finished",
                lastMessage: `EXACT_RESULT_${index}`,
                error: null,
              },
      });
    }
    // Each watcher aborts its signal on completion, so negative assertions wait for the whole path.
    await expect
      .poll(() => signals.length === 2 && signals.every((signal) => signal.aborted))
      .toBe(true);
    if (mode === "parented" || mode === "independent") {
      expect(parentPrompts.join("\n")).toContain("EXACT_RESULT_0");
      expect(parentPrompts.join("\n")).toContain("EXACT_RESULT_1");
      expect(parentPrompts.join("\n")).not.toContain("Untrusted current message");
      expect(reservations).toHaveBeenCalledTimes(2);
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(acknowledgements).toHaveLength(2);
      const stored = (await storage.get(callerId))?.attentionObjectives;
      expect(
        stored?.delegations.map((entry) => entry.deliveries?.map((item) => item.status)),
      ).toEqual([["consumed"], ["consumed"]]);
    } else {
      expect(parentPrompts).toEqual([]);
      expect(enqueue).not.toHaveBeenCalled();
      expect(acknowledgements).toEqual([]);
      expect(
        (await storage.get(callerId))?.attentionObjectives?.delegations.every(
          (entry) => !entry.deliveries?.length,
        ),
      ).toBe(true);
    }
  } finally {
    for (const stop of stops) stop();
    await delivery.close();
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flush();
    rmSync(workdir, { recursive: true, force: true });
  }
});

it.each([
  {
    mode: "failed-write",
    name: "thrown callback reservation snapshot prevents enqueue and acknowledgement and permits retry",
  },
  {
    mode: "restored",
    name: "fresh manager recovers an exact unconsumed callback reservation and delivers once",
  },
  {
    mode: "competing",
    name: "competing live callback watchers cannot both dispatch the same outcome",
  },
  {
    mode: "await-retirement",
    name: "callback watcher retired during the supersession await cannot enqueue or acknowledge and exact retry succeeds",
  },
])("$name", async ({ mode }) => {
  const workdir = mkdtempSync(join(tmpdir(), "attention-callback-recovery-"));
  const logger = createTestLogger();
  const warnings = vi.spyOn(logger, "warn");
  class ReservationStorage extends AgentStorage {
    failNextReservationWrite = false;

    override async applySnapshot(
      agent: ManagedAgent,
      options?: Parameters<AgentStorage["applySnapshot"]>[1],
    ): Promise<void> {
      const hasReservation = agent.attentionObjectives
        ?.snapshot()
        .delegations.some((entry) =>
          entry.deliveries?.some((delivery) => delivery.status === "reserved"),
        );
      if (this.failNextReservationWrite && hasReservation) {
        this.failNextReservationWrite = false;
        // A failed persistence call may already have written the reservation to disk.
        await super.applySnapshot(agent, options);
        throw new Error("Reservation snapshot failed");
      }
      await super.applySnapshot(agent, options);
    }
  }
  let storage = new ReservationStorage(join(workdir, "agents"), logger);
  const prompts: string[] = [];
  const clients = createTestAgentClients({
    onStartTurn: (prompt) => {
      // This fixture prompts only the caller. Its display title is absent from provider resume overrides.
      prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    },
  });
  let manager = new AgentManager({ registry: storage, logger, clients });
  manager.setAttentionHost({ serverId: "origin", resolveRemoteRequester: async () => "unknown" });
  const managers = [manager];
  const callerId = randomUUID();
  const childId = randomUUID();
  const peer = { agentId: childId, serverId: "target" };
  const source = new AgentAttentionObjectives(undefined, "origin");
  source.admit({ inputs: [{ kind: "human", requestId: "human-job" }] });
  source.declare("human-job", "waiting");
  const link = source.outgoing({ recipient: peer })?.requesterObjective;
  if (!link) throw new Error("Expected exact request link");
  await manager.createAgent({ provider: "claude", cwd: workdir, title: "Caller" }, callerId, {
    workspaceId: undefined,
    attentionObjectives: source.snapshot(),
  });
  const child = await manager.createAgent(
    { provider: "claude", cwd: workdir, title: "Child" },
    childId,
    {
      workspaceId: undefined,
      labels: { "paseo.parent-agent-id": callerId, "paseo.parent-server-id": "origin" },
    },
  );
  await manager.flush();
  const outcome = {
    id: randomUUID(),
    requestId: link.requestId,
    requester: { agentId: callerId, serverId: "origin" },
    acceptedTurnId: "target-turn",
    kind: "finished" as const,
    lastMessage: "EXACT_RECOVERED_RESULT",
    error: null,
  };
  const claim = { agentId: callerId, peer, link, outcome, deliveryId: outcome.id };
  const result: WaitForFinishResult = {
    status: "idle",
    final: toAgentPayload(child, { title: "Child" }),
    error: null,
    lastMessage: "Unrelated current content",
    attentionOutcome: outcome,
  };
  const ackIds: string[] = [];
  const acknowledged = Promise.withResolvers<void>();
  const reservationEntered = Promise.withResolvers<void>();
  const returnReservation = Promise.withResolvers<void>();
  const retiredDuringAwait = Promise.withResolvers<void>();
  const stops: Array<() => void> = [];
  const deliveries: Array<ReturnType<typeof createTestAgentMessages>> = [];

  /** Restore the actual persisted source with its full identity and reservation assertions. */
  async function restoreReservedCaller(): Promise<void> {
    // Persist before enqueueing, then discard the manager and all of its live ownership.
    expect((await manager.reserveAttentionCallback(claim)).status).toBe("reserved");
    expect((await storage.get(callerId))?.attentionObjectives?.delegations[0].deliveries).toEqual([
      { outcomeId: outcome.id, deliveryId: outcome.id, status: "reserved" },
    ]);
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    await manager.flush();
    storage = new ReservationStorage(join(workdir, "agents"), logger);
    manager = new AgentManager({ registry: storage, logger, clients });
    managers.push(manager);
    manager.setAttentionHost({
      serverId: "origin",
      resolveRemoteRequester: async () => "unknown",
    });
    await ensureAgentLoaded(callerId, { agentManager: manager, agentStorage: storage, logger });
    expect(manager.listAgents().map((agent) => agent.id)).toEqual([callerId]);
    expect(() =>
      manager.getAgent(callerId)?.attentionObjectives?.assertAdmissions([
        {
          kind: "agent",
          requestId: outcome.id,
          requester: peer,
          attention: {
            continuation: link,
            delivery: { outcomeId: outcome.id, deliveryId: outcome.id },
          },
        },
      ]),
    ).toThrow("Objective");
    await expect(
      manager.reserveAttentionCallback({ ...claim, deliveryId: "other-message" }),
    ).rejects.toThrow("Objective");
  }

  const retireWatcherDuringAwait = () => {
    stops[0]();
    retiredDuringAwait.resolve();
  };
  const queueWatcherRetirement = () => queueMicrotask(retireWatcherDuringAwait);
  try {
    if (mode === "restored") await restoreReservedCaller();
    const delivery = createTestAgentMessages({
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    deliveries.push(delivery);
    const enqueue = vi.spyOn(delivery, "enqueue");
    const release = vi.spyOn(manager, "releaseAttentionCallback");
    const reserve = manager.reserveAttentionCallback.bind(manager);
    if (mode === "failed-write") storage.failNextReservationWrite = true;
    if (mode === "competing") {
      vi.spyOn(manager, "reserveAttentionCallback").mockImplementationOnce(async (input) => {
        const reservation = await reserve(input);
        reservationEntered.resolve();
        await returnReservation.promise;
        return reservation;
      });
    }
    if (mode === "await-retirement") {
      vi.spyOn(manager, "reserveAttentionCallback").mockImplementationOnce(async (input) => {
        const reservation = await reserve(input);
        // The first microtask queues retirement behind the watcher's reservation continuation.
        // That continuation starts awaiting false, then retirement runs before the await resumes.
        queueMicrotask(queueWatcherRetirement);
        return reservation;
      });
    }
    const watch = () => {
      stops.push(
        setupFinishWait({
          agentManager: manager,
          agentStorage: storage,
          agentMessages: delivery,
          originServerId: "origin",
          childServerId: "target",
          childAgentId: childId,
          callerAgentId: callerId,
          attention: { continuation: link },
          logger,
          wait: async (_signal, query) => {
            if (query?.acknowledgeOutcomeId) {
              ackIds.push(query.acknowledgeOutcomeId);
              acknowledged.resolve();
              return { ...result, attentionOutcome: null };
            }
            return result;
          },
          afterPermission: async () => {},
        }),
      );
    };
    watch();
    if (mode === "competing") {
      await reservationEntered.promise;
      // A replacement watcher reaches the same durable reservation while the first still owns it.
      watch();
    }
    if (mode === "await-retirement") {
      await retiredDuringAwait.promise;
      await expect.poll(() => release.mock.calls.length).toBe(1);
      await release.mock.results[0].value;
      expect(enqueue).not.toHaveBeenCalled();
      expect(ackIds).toEqual([]);
      expect(prompts).toEqual([]);
      watch();
    } else if (mode !== "restored") {
      await expect.poll(() => warnings.mock.calls.length).toBe(1);
      expect(enqueue).not.toHaveBeenCalled();
      expect(ackIds).toEqual([]);
      if (mode === "failed-write") {
        // Rollback belongs to reserveAttentionCallback, rather than the caller's enqueue catch.
        expect(release).not.toHaveBeenCalled();
        expect(
          manager.getAgent(callerId)?.attentionObjectives?.snapshot().delegations[0].deliveries,
        ).toEqual([]);
        expect(
          (await storage.get(callerId))?.attentionObjectives?.delegations[0].deliveries,
        ).toEqual([{ outcomeId: outcome.id, deliveryId: outcome.id, status: "reserved" }]);
      } else {
        returnReservation.resolve();
        await expect.poll(() => release.mock.calls.length).toBe(1);
        // Await release completion before retrying the abandoned live owner's outcome.
        await release.mock.results[0].value;
      }
      watch();
    }
    await acknowledged.promise;
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: callerId,
        messageId: outcome.id,
      }),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("EXACT_RECOVERED_RESULT");
    expect(prompts[0]).not.toContain("Unrelated current content");
    expect(ackIds).toEqual([outcome.id]);
    expect((await storage.get(callerId))?.attentionObjectives?.delegations[0].deliveries).toEqual([
      { outcomeId: outcome.id, deliveryId: outcome.id, status: "consumed" },
    ]);
    // Reobservation acknowledges retained evidence without acquiring another dispatch owner.
    watch();
    await expect.poll(() => ackIds.length).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
  } finally {
    returnReservation.resolve();
    for (const stop of stops) stop();
    for (const delivery of deliveries) await delivery.close();
    for (const current of managers.toReversed()) {
      await Promise.all(current.listAgents().map((agent) => current.closeAgent(agent.id)));
      await current.flush();
    }
    warnings.mockRestore();
    rmSync(workdir, { recursive: true, force: true });
  }
});
