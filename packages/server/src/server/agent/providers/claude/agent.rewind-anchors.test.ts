import { mkdtemp, mkdir, appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { AgentManager } from "../../agent-manager.js";
import type { PluginLifecycle } from "../../../plugins/lifecycle/index.js";
import { AgentStorage, type StoredAgentRecord } from "../../agent-storage.js";
import { ensureAgentLoaded } from "../../agent-loading.js";
import { claudeProjectDirSync } from "./project-dir.js";
import type { ClaudeQueryInput } from "./query.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDir } from "./project-dir.js";
import { FakeClaudeSdk } from "./test-rewind-claude-sdk.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import type { AgentSession } from "../../agent-sdk-types.js";

const SESSION_ID = "session-1";

/** Claude Code replies to a turn either with an assistant message or with nothing at all. */
type TurnOutcome = { assistantMessageId: string; subagentMessageId?: string } | "no-response";

function initMessage(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    session_id: SESSION_ID,
    permissionMode: "default",
    model: "claude-sonnet-4-6",
  };
}

/** Claude Code echoes the user message back under the uuid Paseo minted for it. */
function userEcho(uuid: string): Record<string, unknown> {
  return {
    type: "user",
    uuid,
    session_id: SESSION_ID,
    message: { role: "user", content: [{ type: "text", text: "prompt" }] },
  };
}

function assistantReply(uuid: string): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    session_id: SESSION_ID,
    message: { id: uuid, role: "assistant", content: [{ type: "text", text: "ok" }] },
  };
}

/**
 * A message from a Task subagent. The CLI streams these on the same query as the main
 * conversation, and their uuids live on the subagent's sidechain, not on the session's
 * own message chain, so `forkSession` cannot resolve one.
 */
function subagentReply(uuid: string): Record<string, unknown> {
  return {
    type: "assistant",
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: "toolu_subagent_1",
    message: { id: uuid, role: "assistant", content: [{ type: "text", text: "subagent work" }] },
  };
}

function successResult(): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    uuid: "result-ok",
    session_id: SESSION_ID,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "",
    total_cost_usd: 0,
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    permission_denials: [],
  };
}

/** A turn that dies upstream before the model emits its first token. */
function failedResult(): Record<string, unknown> {
  return {
    type: "result",
    subtype: "error_during_execution",
    uuid: "result-failed",
    session_id: SESSION_ID,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    errors: ["upstream gateway returned 503"],
    total_cost_usd: 0,
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 0 },
    permission_denials: [],
  };
}

interface Conversation {
  queryFactory: ReturnType<typeof vi.fn>;
  /** The uuid Paseo minted for each prompt, in the order the turns ran. */
  userMessageIds: string[];
}

function createConversation(outcomes: TurnOutcome[]): Conversation {
  const userMessageIds: string[] = [];
  const queryFactory = vi.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const queued: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    const closedRef = { value: false };
    let turnIndex = 0;

    const wake = () => waiters.shift()?.();
    const enqueue = (message: Record<string, unknown>) => {
      queued.push(message);
      wake();
    };

    void (async () => {
      for await (const sent of prompt) {
        const userMessageId = String((sent as { uuid?: unknown }).uuid);
        userMessageIds.push(userMessageId);
        const outcome = outcomes[turnIndex];
        turnIndex += 1;
        if (turnIndex === 1) {
          enqueue(initMessage());
        }
        enqueue(userEcho(userMessageId));
        if (outcome === "no-response" || !outcome) {
          enqueue(failedResult());
          continue;
        }
        enqueue(assistantReply(outcome.assistantMessageId));
        if (outcome.subagentMessageId) {
          enqueue(subagentReply(outcome.subagentMessageId));
        }
        enqueue(successResult());
      }
      closedRef.value = true;
      wake();
    })();

    return {
      next: vi.fn(async () => {
        while (queued.length === 0 && !closedRef.value) {
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
        }
        if (queued.length === 0) {
          return { done: true, value: undefined };
        }
        return { done: false, value: queued.shift() };
      }),
      interrupt: vi.fn(async () => undefined),
      return: vi.fn(async () => {
        closedRef.value = true;
        wake();
        return undefined;
      }),
      close: vi.fn(() => {
        closedRef.value = true;
        wake();
      }),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      applyFlagSettings: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      rewindFiles: vi.fn(async () => ({ canRewind: true })),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  });
  return { queryFactory, userMessageIds };
}

async function createSession(
  conversation: Conversation,
  rewindSdk: FakeClaudeSdk,
): Promise<AgentSession> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: conversation.queryFactory as never,
    resolveBinary: async () => "/test/claude/bin",
    rewindSdk,
  });
  return client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    model: "claude-sonnet-4-6",
  });
}

async function runTurns(session: AgentSession, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    for await (const _ of streamSession(session, `turn ${index + 1}`)) {
      // drain to the terminal event
    }
  }
}

describe("Claude rewind across a turn that produced no response", () => {
  test("forks at the most recent turn that did produce a response", async () => {
    const conversation = createConversation([
      { assistantMessageId: "assistant-1" },
      "no-response",
      { assistantMessageId: "assistant-3" },
    ]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createSession(conversation, rewindSdk);

    try {
      await runTurns(session, 3);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[2] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "assistant-1" }]);
  });

  test("starts a fresh session when no earlier turn produced a response", async () => {
    const conversation = createConversation(["no-response", { assistantMessageId: "assistant-2" }]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createSession(conversation, rewindSdk);

    try {
      await runTurns(session, 2);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[1] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([]);
  });

  test("still forks at the previous turn when every turn produced a response", async () => {
    const conversation = createConversation([
      { assistantMessageId: "assistant-1" },
      { assistantMessageId: "assistant-2" },
    ]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createSession(conversation, rewindSdk);

    try {
      await runTurns(session, 2);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[1] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "assistant-1" }]);
  });
});

describe("Claude rewind after a turn whose last assistant message came from a subagent", () => {
  test("forks at the turn's own reply, not at the subagent message", async () => {
    const conversation = createConversation([
      { assistantMessageId: "assistant-1", subagentMessageId: "subagent-1" },
      { assistantMessageId: "assistant-2" },
    ]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createSession(conversation, rewindSdk);

    try {
      await runTurns(session, 2);
      await session.revertConversation?.({ messageId: conversation.userMessageIds[1] });
    } finally {
      await session.close();
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "assistant-1" }]);
  });
});

async function configuredRewindFixture(
  outcomes: TurnOutcome[],
  fixtureOptions: { env?: Record<string, string>; pluginLifecycle?: PluginLifecycle } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-configured-rewind-"));
  vi.stubEnv("HOME", root);
  const home = path.join(root, "profile");
  await mkdir(home);
  const project = claudeProjectDirSync(root, { configDir: home });
  await mkdir(project, { recursive: true });
  const conversation = createConversation(outcomes);
  let queryCount = 0;
  let unexpectedId: string | undefined;
  let failQuery = false;
  let beforeInit: (() => Promise<void>) | undefined;
  let omitTranscript = false;
  const queryFactory = vi.fn((input: ClaudeQueryInput) => {
    queryCount++;
    if (failQuery) throw new Error("fixture-query-start-failed");
    const id = input.options.resume ?? (queryCount === 1 ? SESSION_ID : "fresh-actual-session");
    const inner = conversation.queryFactory(input);
    const next = inner.next.bind(inner);
    inner.next = async () => {
      const result = await next();
      if (!result.done) {
        if (result.value.type === "system" && result.value.subtype === "init" && beforeInit) {
          const action = beforeInit;
          beforeInit = undefined;
          await action();
        }
        result.value = {
          ...result.value,
          session_id: unexpectedId ?? id,
          sessionId: unexpectedId ?? id,
        };
        if (!omitTranscript)
          await appendFile(
            path.join(project, `${unexpectedId ?? id}.jsonl`),
            JSON.stringify(result.value) + "\n",
          );
      }
      return result;
    };
    return inner;
  });
  const sdk = new FakeClaudeSdk();
  const fork = sdk.forkSession.bind(sdk);
  sdk.forkSession = async (id, options) => {
    const result = await fork(id, options);
    await appendFile(
      path.join(project, result.sessionId + ".jsonl"),
      JSON.stringify({
        type: "user",
        sessionId: result.sessionId,
        uuid: "fork-user",
        message: { role: "user", content: "fixture fork" },
      }) + "\n",
    );
    return result;
  };
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    historyPolicy: { mode: "configured" },
    runtimeSettings: { env: { CLAUDE_CONFIG_DIR: home } },
    queryFactory: queryFactory as never,
    rewindSdk: sdk,
    resolveBinary: async () => "/fixture/never-spawned-claude",
  });
  vi.spyOn(client, "isAvailable").mockResolvedValue(true);
  const storagePath = path.join(root, "agents");
  const storage = new AgentStorage(storagePath, createTestLogger());
  const manager = new AgentManager({
    clients: { claude: client },
    registry: storage,
    logger: createTestLogger(),
    pluginLifecycle: fixtureOptions.pluginLifecycle,
  });
  const failures: unknown[] = [];
  const agent = await manager.createAgent(
    { provider: "claude", cwd: root, model: "claude-sonnet-4-6" },
    undefined,
    { workspaceId: "original-workspace", env: fixtureOptions.env },
  );
  if (!agent.session) throw new Error("fixture session missing");
  agent.session.subscribe((event) => {
    if (event.type === "turn_failed") failures.push(event);
  });
  return {
    root,
    home,
    project,
    sdk,
    client,
    storagePath,
    storage,
    manager,
    agent,
    failures,
    setBeforeInit: (action: () => Promise<void>) => {
      beforeInit = action;
    },
    omitTranscript: () => {
      omitTranscript = true;
    },
    setUnexpectedId: (id: string) => {
      unexpectedId = id;
    },
    setQueryFailure: (fail: boolean) => {
      failQuery = fail;
    },
    session: agent.session,
    conversation,
    cleanup: async () => {
      await manager.closeAgent(agent.id).catch(() => {});
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function driftMutation(field: string) {
  return (r: StoredAgentRecord) => ({
    ...r,
    ...(field === "config" ? { config: { ...r.config, model: "changed-after-admission" } } : {}),
    ...(field === "launchEnv"
      ? { launchEnv: { CLAUDE_CODE_ENTRYPOINT: "changed-after-admission" } }
      : {}),
    ...(field === "workspace" ? { workspaceId: "changed-workspace" } : {}),
    ...(field === "archive" ? { archivedAt: "2026-11-02T00:00:00.000Z" } : {}),
    ...(field === "provider" ? { provider: "other-profile" } : {}),
    ...(field === "recovery"
      ? {
          persistence: {
            provider: "claude",
            sessionId: "unexpected-recovery",
            nativeHandle: "unexpected-recovery",
          },
        }
      : {}),
    ...(field === "activity"
      ? { lastStatus: "running", lastActivityAt: "2026-11-02T01:00:00.000Z" }
      : {}),
  });
}

function assertDriftMetadata(actual: StoredAgentRecord | null, field: string): void {
  if (field === "launchEnv")
    expect(actual?.launchEnv).toEqual({ CLAUDE_CODE_ENTRYPOINT: "changed-after-admission" });
  if (field === "workspace") expect(actual?.workspaceId).toBe("changed-workspace");
  if (field === "config") expect(actual?.config?.model).toBe("changed-after-admission");
  if (field === "provider") expect(actual?.provider).toBe("other-profile");
  if (field === "recovery") expect(actual?.persistence?.sessionId).toBe("unexpected-recovery");
}

describe("configured Claude managed rewind", () => {
  test("empty registered chat restarts before first prompt without changing ID, binding or metadata", async () => {
    const hooks: string[] = [];
    const opens: string[] = [];
    const pluginLifecycle: PluginLifecycle = {
      wait: async () => {},
      emit: (name) => {
        hooks.push(name);
      },
      before: async (name, request) => {
        hooks.push(name);
        if ("reason" in request) opens.push(String(request.reason));
        return request;
      },
    };
    const env = { CLAUDE_CODE_ENTRYPOINT: "saved-explicit-entrypoint" };
    const f = await configuredRewindFixture([{ assistantMessageId: "a1" }], {
      env,
      pluginLifecycle,
    });
    let restarted: AgentManager | undefined;
    try {
      await f.storage.setTitle(f.agent.id, "original empty title");
      await f.manager.closeAgent(f.agent.id);
      const before = (await f.storage.get(f.agent.id))!;
      expect(before.persistence).toBeNull();
      const registry = new AgentStorage(f.storagePath, createTestLogger());
      restarted = new AgentManager({
        clients: { claude: f.client },
        registry,
        logger: createTestLogger(),
        pluginLifecycle,
      });
      await expect(
        restarted.createAgent({ provider: "claude", cwd: f.root, model: "different" }, f.agent.id, {
          workspaceId: "original-workspace",
        }),
      ).rejects.toThrow("already has durable state");
      const loaded = await ensureAgentLoaded(f.agent.id, {
        agentManager: restarted,
        agentStorage: registry,
        logger: createTestLogger(),
      });
      expect(loaded.id).toBe(f.agent.id);
      expect(hooks.filter((name) => name === "agent.create.before")).toHaveLength(1);
      expect(hooks.filter((name) => name === "agent.create.after")).toHaveLength(1);
      expect(opens.at(-1)).toBe("resume");
      const reopened = await registry.get(f.agent.id);
      expect(reopened).toMatchObject({
        createdAt: before.createdAt,
        updatedAt: before.updatedAt,
        title: "original empty title",
        workspaceId: "original-workspace",
        providerHistory: before.providerHistory,
        config: before.config,
        launchEnv: env,
      });
      if (!loaded.session) throw new Error("fixture empty session missing");
      await runTurns(loaded.session, 1);
      expect((await registry.get(f.agent.id))?.persistence?.sessionId).toBe(SESSION_ID);
    } finally {
      await restarted?.closeAgent(f.agent.id).catch(() => {});
      await f.cleanup();
    }
  });
  test.each(["conversation", "both"] as const)(
    "%s commits actual fork before publishing and retains identity/config",
    async (mode) => {
      const f = await configuredRewindFixture([
        { assistantMessageId: "assistant-1" },
        { assistantMessageId: "assistant-2" },
      ]);
      try {
        await runTurns(f.session, 2);
        expect(f.session.describePersistence(), JSON.stringify(f.failures)).not.toBeNull();
        await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], mode);
        const record = await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id);
        expect(record).toMatchObject({
          id: f.agent.id,
          workspaceId: "original-workspace",
          persistence: { sessionId: "forked-session-1" },
          providerHistory: {
            origin: "created",
            sessionId: "forked-session-1",
            storage: { provider: "claude", home: f.home },
          },
        });
        expect(f.session.describePersistence()?.sessionId).toBe("forked-session-1");
        expect(await readFile(path.join(f.project, "forked-session-1.jsonl"), "utf8")).toContain(
          "fixture fork",
        );
      } finally {
        await f.cleanup();
      }
    },
  );
  test("configured rewind blocks concurrent history and prompt admission while retiring the old query", async () => {
    const f = await configuredRewindFixture([
      { assistantMessageId: "a1" },
      { assistantMessageId: "a2" },
    ]);
    const retiring = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let rewind: Promise<void> | undefined;
    try {
      await runTurns(f.session, 2);
      const query = f.conversation.queryFactory.mock.results[0].value;
      vi.spyOn(query, "return").mockImplementationOnce(async () => {
        retiring.resolve();
        await release.promise;
      });
      rewind = f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
      await retiring.promise;
      let historyDone = false;
      const reading = Array.fromAsync(f.session.streamHistory()).then((rows) => {
        historyDone = true;
        return rows;
      });
      let promptDone = false;
      const starting = f.session.startTurn("continue the committed fork").then(() => {
        promptDone = true;
        return undefined;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(historyDone).toBe(false);
      expect(promptDone).toBe(false);
      release.resolve();
      await rewind;
      const rows = await reading;
      await starting;
      expect(JSON.stringify(rows)).toContain("fixture fork");
      expect(f.session.describePersistence()?.sessionId).toBe("forked-session-1");
      expect(
        (await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id))?.persistence
          ?.sessionId,
      ).toBe("forked-session-1");
      expect(f.conversation.queryFactory.mock.calls.at(-1)?.[0].options.resume).toBe(
        "forked-session-1",
      );
    } finally {
      release.resolve();
      await rewind?.catch(() => {});
      await f.cleanup();
    }
  });
  test("external close and reopen await detached retirement cleanup during configured rewind", async () => {
    const f = await configuredRewindFixture([
      { assistantMessageId: "a1" },
      { assistantMessageId: "a2" },
    ]);
    const retiring = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let rewind: Promise<unknown> | undefined;
    let reopening: Promise<unknown> | undefined;
    try {
      await runTurns(f.session, 2);
      const query = f.conversation.queryFactory.mock.results[0].value;
      vi.spyOn(query, "return").mockImplementationOnce(async () => {
        retiring.resolve();
        await release.promise;
      });
      rewind = f.manager
        .rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation")
        .catch((error) => error);
      await retiring.promise;
      const resume = vi.spyOn(f.client, "resumeSession");
      const closeEntered = Promise.withResolvers<void>();
      const close = f.session.close.bind(f.session);
      let providerCloseDone = false;
      vi.spyOn(f.session, "close").mockImplementationOnce(async () => {
        closeEntered.resolve();
        await close();
        providerCloseDone = true;
      });
      let closeDone = false;
      let reopenDone = false;
      const closing = f.manager.closeAgent(f.agent.id).then(() => {
        closeDone = true;
        return undefined;
      });
      reopening = closing.then(async () => {
        const loaded = await ensureAgentLoaded(f.agent.id, {
          agentManager: f.manager,
          agentStorage: f.storage,
          logger: createTestLogger(),
        });
        reopenDone = true;
        return loaded;
      });
      await closeEntered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(providerCloseDone).toBe(false);
      expect(closeDone).toBe(false);
      expect(reopenDone).toBe(false);
      expect(resume).not.toHaveBeenCalled();
      release.resolve();
      const error = await rewind;
      expect(error).toBeInstanceOf(Error);
      await reopening;
      expect(resume).toHaveBeenCalledOnce();
      expect(f.manager.getAgent(f.agent.id)?.persistence?.sessionId).toBe(SESSION_ID);
      expect(
        (await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id))?.persistence
          ?.sessionId,
      ).toBe(SESSION_ID);
    } finally {
      release.resolve();
      await rewind;
      await reopening;
      await f.cleanup();
    }
  });

  test("SDK close rejection retains retirement ownership until iterator cleanup settles", async () => {
    const f = await configuredRewindFixture([
      { assistantMessageId: "a1" },
      { assistantMessageId: "a2" },
    ]);
    const retiring = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let rewind: Promise<unknown> | undefined;
    let closing: Promise<unknown> | undefined;
    try {
      await runTurns(f.session, 2);
      const query = f.conversation.queryFactory.mock.results[0].value;
      vi.spyOn(query, "close").mockImplementationOnce(() => {
        throw new Error("fixture-sdk-close-failed");
      });
      const returned = vi.spyOn(query, "return").mockImplementationOnce(async () => {
        retiring.resolve();
        await release.promise;
      });
      rewind = f.manager
        .rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation")
        .catch((error) => error);
      await retiring.promise;
      let closeDone = false;
      closing = f.session
        .close()
        .catch((error) => error)
        .then((result) => {
          closeDone = true;
          return result;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeDone).toBe(false);
      release.resolve();
      expect(await closing).toMatchObject({ message: "fixture-sdk-close-failed" });
      expect(await rewind).toMatchObject({ message: "fixture-sdk-close-failed" });
      expect(returned).toHaveBeenCalledOnce();
      expect(
        (await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id))?.persistence
          ?.sessionId,
      ).toBe(SESSION_ID);
    } finally {
      release.resolve();
      await rewind;
      await closing;
      await f.cleanup();
    }
  });
  test("normal fork adoption failure before assignment preserves canonical recovery without an old-handle snapshot", async () => {
    const f = await configuredRewindFixture([
      { assistantMessageId: "a1" },
      { assistantMessageId: "a2" },
    ]);
    try {
      await runTurns(f.session, 2);
      const revert = f.session.revertConversation!.bind(f.session);
      vi.spyOn(f.session, "revertConversation").mockImplementationOnce((input) =>
        revert({
          ...input,
          commitClaudeRewind: (transition) =>
            input.commitClaudeRewind!({
              ...transition,
              adopt: () => {
                throw new Error("fixture-before-assignment");
              },
            }),
        }),
      );
      let committed = false;
      const commit = f.storage.commitClaudeRewind.bind(f.storage);
      vi.spyOn(f.storage, "commitClaudeRewind").mockImplementationOnce((input) =>
        commit({
          ...input,
          onCommitted: (record) => {
            committed = true;
            input.onCommitted(record);
          },
        }),
      );
      const staleSnapshots: string[] = [];
      const snapshot = f.storage.applySnapshot.bind(f.storage);
      vi.spyOn(f.storage, "applySnapshot").mockImplementation((agent, options) => {
        if (committed && agent.persistence?.sessionId === SESSION_ID)
          staleSnapshots.push(agent.persistence.sessionId);
        return snapshot(agent, options);
      });
      await expect(
        f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation"),
      ).rejects.toThrow("rewind-committed-adoption-failed:forked-session-1");
      expect(staleSnapshots).toEqual([]);
      expect(f.manager.getAgent(f.agent.id)).toBeNull();
      expect(
        (await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id))?.persistence
          ?.sessionId,
      ).toBe("forked-session-1");
      const loaded = await ensureAgentLoaded(f.agent.id, {
        agentManager: f.manager,
        agentStorage: f.storage,
        logger: createTestLogger(),
      });
      expect(loaded.persistence?.sessionId).toBe("forked-session-1");
    } finally {
      await f.cleanup();
    }
  });
  test("combined fork failure reports files-first partial effect and keeps prior native identity", async () => {
    const f = await configuredRewindFixture([
      { assistantMessageId: "a1" },
      { assistantMessageId: "a2" },
    ]);
    try {
      await runTurns(f.session, 2);
      f.sdk.forkSession = async () => {
        throw new Error("fixture-fork-failed");
      };
      await expect(
        f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "both"),
      ).rejects.toThrow("files were rewound; conversation rewind failed");
      expect((await f.storage.get(f.agent.id))?.persistence?.sessionId).toBe(SESSION_ID);
      expect(f.session.describePersistence()?.sessionId).toBe(SESSION_ID);
    } finally {
      await f.cleanup();
    }
  });
  test("post-fork CAS failure preserves prior resumable handle and child", async () => {
    const f = await configuredRewindFixture([
      { assistantMessageId: "assistant-1" },
      { assistantMessageId: "assistant-2" },
    ]);
    try {
      await runTurns(f.session, 2);
      const fork = f.sdk.forkSession.bind(f.sdk);
      f.sdk.forkSession = async (id, options) => {
        const child = await fork(id, options);
        await f.storage.setTitle(f.agent.id, "concurrent title");
        return child;
      };
      await expect(
        f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation"),
      ).rejects.toThrow("child forked-session-1 retained");
      expect(f.session.describePersistence()?.sessionId).toBe(SESSION_ID);
      expect(
        await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id),
      ).toMatchObject({ title: "concurrent title", persistence: { sessionId: SESSION_ID } });
      expect(await readFile(path.join(f.project, "forked-session-1.jsonl"), "utf8")).toContain(
        "fixture fork",
      );
    } finally {
      await f.cleanup();
    }
  });
  test("unexpected hook session switch preserves first actual canonical ID", async () => {
    const f = await configuredRewindFixture([
      { assistantMessageId: "a1" },
      { assistantMessageId: "a2" },
    ]);
    try {
      await runTurns(f.session, 1);
      f.setUnexpectedId("unexpected-hook-id");
      await runTurns(f.session, 1);
      expect(JSON.stringify(f.failures)).toContain("unexpected-session-id-change");
      expect(f.session.describePersistence()?.sessionId).toBe(SESSION_ID);
      const disk = await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id);
      expect(disk?.providerHistory?.sessionId).toBe(SESSION_ID);
      expect(disk?.persistence?.sessionId).toBe(SESSION_ID);
    } finally {
      await f.cleanup();
    }
  });
  test("failed marked fresh query retains intent, recovery handle and empty view, then retries", async () => {
    const f = await configuredRewindFixture(["no-response", { assistantMessageId: "a2" }]);
    try {
      await runTurns(f.session, 2);
      await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
      const operationId = (await f.storage.get(f.agent.id))?.claudeFreshRewind?.operationId;
      f.setQueryFailure(true);
      await runTurns(f.session, 1);
      expect(JSON.stringify(f.failures)).toContain("fixture-query-start-failed");
      expect((await f.storage.get(f.agent.id))?.claudeFreshRewind?.operationId).toBe(operationId);
      expect(f.session.describePersistence()?.sessionId).toBe(SESSION_ID);
      const failedView = f.manager
        .fetchTimeline(f.agent.id, { limit: 0 })
        .rows.map((row) => row.item);
      expect(failedView.some((item) => item.type === "user_message")).toBe(false);
      expect(JSON.stringify(failedView)).toContain("fixture-query-start-failed");
      f.setQueryFailure(false);
      await runTurns(f.session, 1);
      expect((await f.storage.get(f.agent.id))?.claudeFreshRewind).toBeUndefined();
      expect(f.session.describePersistence()?.sessionId).toBe("fresh-actual-session");
    } finally {
      await f.cleanup();
    }
  });
  test.each(["initial", "fresh"] as const)(
    "%s cancellation during admission never submits the canceled prompt or consumes identity",
    async (phase) => {
      const f = await configuredRewindFixture(["no-response", { assistantMessageId: "a2" }]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      try {
        if (phase === "fresh") {
          await runTurns(f.session, 2);
          await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
        }
        const before = (await f.storage.get(f.agent.id))!;
        const context =
          phase === "initial" ? f.session.claudeInitialHistory! : f.session.claudeFreshRewind!;
        const admit = context.admit.bind(context);
        vi.spyOn(context, "admit").mockImplementationOnce(async () => {
          await admit();
          entered.resolve();
          await release.promise;
        });
        const count = f.conversation.userMessageIds.length;
        const events: unknown[] = [];
        f.session.subscribe((event) => events.push(event));
        const starting = f.session.startTurn("never submit this canceled prompt");
        await entered.promise;
        await f.session.interrupt();
        release.resolve();
        await starting;
        expect(f.conversation.userMessageIds).toHaveLength(count);
        expect(JSON.stringify(events)).toContain('"type":"turn_canceled"');
        expect(JSON.stringify(events)).not.toContain("never submit this canceled prompt");
        const after = await f.storage.get(f.agent.id);
        expect(after?.providerHistory).toEqual(before.providerHistory);
        expect(after?.persistence).toEqual(before.persistence);
        expect(after?.claudeFreshRewind).toEqual(before.claudeFreshRewind);
      } finally {
        release.resolve();
        await f.cleanup();
      }
    },
  );
  test.each(["initial", "fresh"] as const)(
    "%s retired query cannot commit an acknowledgment delayed before the storage queue",
    async (phase) => {
      const f = await configuredRewindFixture(["no-response", { assistantMessageId: "a2" }]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const settled = Promise.withResolvers<void>();
      const assertions = vi.fn();
      try {
        if (phase === "fresh") {
          await runTurns(f.session, 2);
          await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
        }
        const before = (await f.storage.get(f.agent.id))!;
        if (phase === "initial") {
          const commit = f.storage.commitClaudeInitialHandle.bind(f.storage);
          vi.spyOn(f.storage, "commitClaudeInitialHandle").mockImplementationOnce(async (input) => {
            entered.resolve();
            await release.promise;
            try {
              return await commit({
                ...input,
                assertCurrent: () => {
                  assertions();
                  input.assertCurrent?.();
                },
              });
            } finally {
              settled.resolve();
            }
          });
        } else {
          const commit = f.storage.commitClaudeRewind.bind(f.storage);
          vi.spyOn(f.storage, "commitClaudeRewind").mockImplementationOnce(async (input) => {
            entered.resolve();
            await release.promise;
            try {
              return await commit({
                ...input,
                assertCurrent: () => {
                  assertions();
                  input.assertCurrent?.();
                },
              });
            } finally {
              settled.resolve();
            }
          });
        }
        const events: unknown[] = [];
        f.session.subscribe((event) => events.push(event));
        const turn = runTurns(f.session, 1);
        await entered.promise;
        await f.session.close();
        release.resolve();
        await settled.promise;
        await turn;
        expect(assertions).toHaveBeenCalledOnce();
        const after = (await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id))!;
        expect(after.providerHistory).toEqual(before.providerHistory);
        expect(after.persistence).toEqual(before.persistence);
        expect(after.claudeFreshRewind).toEqual(before.claudeFreshRewind);
        expect(JSON.stringify(events)).not.toContain('"messageId":"a2"');
        const id = phase === "fresh" ? "fresh-actual-session" : SESSION_ID;
        expect(await readFile(path.join(f.project, `${id}.jsonl`), "utf8")).toContain(
          '"subtype":"init"',
        );
      } finally {
        release.resolve();
        await f.cleanup();
      }
    },
  );
  test.each(["initial", "fresh"] as const)(
    "%s missing persisted transcript retains recovery state without polling",
    async (phase) => {
      const f = await configuredRewindFixture(["no-response", { assistantMessageId: "a2" }]);
      try {
        if (phase === "fresh") {
          await runTurns(f.session, 2);
          await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
        }
        f.omitTranscript();
        await runTurns(f.session, 1);
        expect(JSON.stringify(f.failures)).toContain("rewind-transcript-missing");
        const record = await f.storage.get(f.agent.id);
        expect(record?.persistence?.sessionId ?? null).toBe(phase === "fresh" ? SESSION_ID : null);
        if (phase === "fresh") expect(record?.claudeFreshRewind).toBeDefined();
      } finally {
        await f.cleanup();
      }
    },
  );
  test.each(["initial", "fresh"] as const)(
    "%s query rejects protected drift after admission and permits status/activity writes",
    async (phase) => {
      for (const field of [
        "config",
        "launchEnv",
        "workspace",
        "archive",
        "provider",
        "recovery",
        "activity",
      ] as const) {
        const f = await configuredRewindFixture(["no-response", { assistantMessageId: "a2" }]);
        try {
          if (phase === "fresh") {
            await runTurns(f.session, 2);
            await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
          }
          f.setBeforeInit(async () => {
            const record = await f.storage.get(f.agent.id, { includeHistoryIntents: true });
            if (!record) throw new Error("fixture agent record missing");
            await f.storage.upsert(driftMutation(field)(record));
          });
          await runTurns(f.session, 1);
          const actual = await f.storage.get(f.agent.id);
          if (field === "activity") {
            expect(actual?.providerHistory?.sessionId).toBe(
              phase === "fresh" ? "fresh-actual-session" : SESSION_ID,
            );
            expect(actual?.claudeFreshRewind).toBeUndefined();
          } else {
            expect(JSON.stringify(f.failures), field).toMatch(/binding failed|commit failed/);
            expect(actual?.providerHistory?.sessionId, field).toBe(
              phase === "fresh" ? SESSION_ID : null,
            );
            assertDriftMetadata(actual, field);
            expect(
              phase === "fresh"
                ? f.session.claudeFreshRewind?.admission
                : f.session.claudeInitialHistory?.admission,
            ).toBeDefined();
            await expect(f.storage.applySnapshot(f.agent)).rejects.toThrow(
              "query-admission-identity-changed",
            );
            assertDriftMetadata(await f.storage.get(f.agent.id), field);
          }
        } finally {
          await f.cleanup();
        }
      }
    },
  );
  test.each(["initial", "fresh"] as const)(
    "%s admission accepts legitimate model edits before the requested query",
    async (phase) => {
      const f = await configuredRewindFixture(["no-response", { assistantMessageId: "a2" }]);
      try {
        if (phase === "fresh") {
          await runTurns(f.session, 2);
          await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
        }
        await f.manager.setAgentModel(f.agent.id, "claude-opus-4-6");
        await runTurns(f.session, 1);
        expect(
          (await f.storage.get(f.agent.id))?.providerHistory?.sessionId,
          JSON.stringify(f.failures),
        ).toBe(phase === "fresh" ? "fresh-actual-session" : SESSION_ID);
      } finally {
        await f.cleanup();
      }
    },
  );
  test("post-commit adoption failure retains committed identity and retires runtime for reopen", async () => {
    const f = await configuredRewindFixture([
      { assistantMessageId: "a1" },
      { assistantMessageId: "a2" },
    ]);
    try {
      await runTurns(f.session, 2);
      const original = f.storage.commitClaudeRewind.bind(f.storage);
      const spy = vi.spyOn(f.storage, "commitClaudeRewind").mockImplementation((input) =>
        original({
          ...input,
          onCommitted: (record) => {
            input.onCommitted(record);
            throw new Error("fixture-adoption-failure");
          },
        }),
      );
      await expect(
        f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation"),
      ).rejects.toThrow("retained");
      spy.mockRestore();
      const disk = await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id);
      expect(disk?.persistence?.sessionId).toBe("forked-session-1");
      expect(f.manager.getAgent(f.agent.id)).toBeNull();
      const loaded = await ensureAgentLoaded(f.agent.id, {
        agentManager: f.manager,
        agentStorage: f.storage,
        logger: createTestLogger(),
      });
      expect(loaded.persistence?.sessionId).toBe("forked-session-1");
    } finally {
      await f.cleanup();
    }
  });
  test("rewind callback expires after settlement and old fresh callback expires after reload", async () => {
    const f = await configuredRewindFixture([
      { assistantMessageId: "a1" },
      { assistantMessageId: "a2" },
    ]);
    try {
      await runTurns(f.session, 2);
      let captured: import("../../agent-sdk-types.js").AgentRewindInput | undefined;
      const original = f.session.revertConversation!.bind(f.session);
      vi.spyOn(f.session, "revertConversation").mockImplementation(async (input) => {
        captured = input;
        return original(input);
      });
      await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
      await expect(
        captured!.commitClaudeRewind!({
          previous: { provider: "claude", sessionId: SESSION_ID },
          next: { provider: "claude", sessionId: "other" },
          storage: { kind: "configured-home", provider: "claude", home: f.home },
          adopt: () => {
            throw new Error("must not adopt");
          },
        }),
      ).rejects.toThrow("stale-rewind-callback");
    } finally {
      await f.cleanup();
    }
    const fresh = await configuredRewindFixture(["no-response", { assistantMessageId: "a2" }]);
    try {
      await runTurns(fresh.session, 2);
      await fresh.manager.rewind(
        fresh.agent.id,
        fresh.conversation.userMessageIds[1],
        "conversation",
      );
      const stale = fresh.session.claudeFreshRewind!;
      await fresh.manager.reloadAgentSession(fresh.agent.id);
      const snapshots = vi.spyOn(fresh.storage, "applySnapshot");
      await expect(stale.admit()).rejects.toThrow("fresh-query-admission-conflict");
      expect(snapshots).not.toHaveBeenCalled();
      snapshots.mockRestore();
    } finally {
      await fresh.cleanup();
    }
  });
  test("initial post-commit adoption failure requires reload without another SDK query or turn", async () => {
    const f = await configuredRewindFixture([{ assistantMessageId: "a1" }]);
    try {
      const context = f.session.claudeInitialHistory!;
      const commit = context.commit;
      context.commit = (transition) =>
        commit({
          ...transition,
          adopt: () => {
            throw new Error("fixture-initial-adoption-failure");
          },
        });
      await runTurns(f.session, 1);
      const disk = await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id);
      expect(disk).toMatchObject({
        persistence: { sessionId: SESSION_ID, nativeHandle: SESSION_ID },
        providerHistory: { sessionId: SESSION_ID, origin: "created" },
      });
      expect(JSON.stringify(f.failures)).toContain(
        `identity ${SESSION_ID} committed; runtime adoption failed; reload required`,
      );
      expect(JSON.stringify(f.failures)).not.toContain("retained");
      expect(context.admission).toBeUndefined();
      await expect(context.admit()).rejects.toThrow("initial-admission-conflict-reload-required");
      await expect(
        context.commit({
          storage: { kind: "configured-home", provider: "claude", home: f.home },
          next: { provider: "claude", sessionId: "stale-initial-child" },
          adopt: () => {
            throw new Error("must not adopt stale callback");
          },
        }),
      ).rejects.toThrow("stale-initial-history-callback");
      const queries = f.conversation.queryFactory.mock.calls.length;
      const turns = f.conversation.userMessageIds.length;
      const query = f.conversation.queryFactory.mock.results[0].value;
      const pump = vi.spyOn(query, "next");
      await expect(f.session.startTurn("must reload")).rejects.toThrow(
        "committed-identity-reload-required",
      );
      expect(pump).not.toHaveBeenCalled();
      expect(f.conversation.queryFactory).toHaveBeenCalledTimes(queries);
      expect(f.conversation.userMessageIds).toHaveLength(turns);
      pump.mockRestore();
      const reloaded = await f.manager.reloadAgentSession(f.agent.id, undefined, {
        rehydrateFromDisk: true,
      });
      expect(reloaded.persistence?.sessionId).toBe(SESSION_ID);
      expect(reloaded.session?.describePersistence()?.sessionId).toBe(SESSION_ID);
      expect(reloaded.session?.historyStorage).toEqual(disk?.providerHistory?.storage);
      expect(
        (await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id))?.persistence,
      ).toEqual(disk?.persistence);
    } finally {
      await f.cleanup();
    }
  });
  test("fresh post-commit adoption error reports committed ID without pump deadlock and requires reload", async () => {
    const f = await configuredRewindFixture(["no-response", { assistantMessageId: "a2" }]);
    try {
      await runTurns(f.session, 2);
      await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
      const original = f.storage.commitClaudeRewind.bind(f.storage);
      const spy = vi.spyOn(f.storage, "commitClaudeRewind").mockImplementation((input) =>
        original({
          ...input,
          onCommitted: (record) => {
            input.onCommitted(record);
            throw new Error("fixture-fresh-adoption-failure");
          },
        }),
      );
      await runTurns(f.session, 1);
      spy.mockRestore();
      expect(JSON.stringify(f.failures)).toContain(
        "identity fresh-actual-session committed; runtime adoption failed; reload required",
      );
      expect((await f.storage.get(f.agent.id))?.persistence?.sessionId).toBe(
        "fresh-actual-session",
      );
      await expect(f.session.startTurn("must reload")).rejects.toThrow(
        "committed-identity-reload-required",
      );
      const reloaded = await f.manager.reloadAgentSession(f.agent.id);
      expect(reloaded.persistence?.sessionId).toBe("fresh-actual-session");
    } finally {
      await f.cleanup();
    }
  });
  test("fresh rewind survives restart with old recovery handle and consumes intent on actual new query", async () => {
    const f = await configuredRewindFixture(["no-response", { assistantMessageId: "assistant-2" }]);
    let restarted: AgentManager | undefined;
    try {
      await runTurns(f.session, 2);
      await f.manager.rewind(f.agent.id, f.conversation.userMessageIds[1], "conversation");
      const pending = await f.storage.get(f.agent.id);
      expect(pending?.persistence?.sessionId).toBe(SESSION_ID);
      expect(pending?.claudeFreshRewind?.operationId).toEqual(expect.any(String));
      expect(f.manager.fetchTimeline(f.agent.id, { limit: 0 }).rows).toEqual([]);
      await f.manager.closeAgent(f.agent.id);
      const reloadedStorage = new AgentStorage(f.storagePath, createTestLogger());
      restarted = new AgentManager({
        clients: { claude: f.client },
        registry: reloadedStorage,
        logger: createTestLogger(),
      });
      const loaded = await ensureAgentLoaded(f.agent.id, {
        agentManager: restarted,
        agentStorage: reloadedStorage,
        logger: createTestLogger(),
      });
      expect(restarted.fetchTimeline(f.agent.id, { limit: 0 }).rows).toEqual([]);
      if (!loaded.session) throw new Error("fixture resumed session missing");
      expect(await Array.fromAsync(loaded.session.streamHistory())).toEqual([]);
      expect(loaded.session.describePersistence()?.sessionId).toBe(SESSION_ID);
      const failures: unknown[] = [];
      loaded.session.subscribe((event) => {
        if (event.type === "turn_failed") failures.push(event);
      });
      await runTurns(loaded.session, 1);
      await restarted.rewind(f.agent.id, "unused", "files");
      const committed = await new AgentStorage(f.storagePath, createTestLogger()).get(f.agent.id);
      expect(committed?.claudeFreshRewind, JSON.stringify(failures)).toBeUndefined();
      expect(committed?.persistence?.sessionId).toBe("fresh-actual-session");
      expect(committed?.providerHistory?.origin).toBe("created");
    } finally {
      await restarted?.closeAgent(f.agent.id).catch(() => {});
      await f.cleanup();
    }
  });
});

describe("Claude rewind to a message steered into a running turn", () => {
  test("forks at the entry Claude read the message after", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "claude-rewind-steer-"));
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const conversation = createConversation([{ assistantMessageId: "assistant-1" }]);
    const rewindSdk = new FakeClaudeSdk();
    const session = await createSession(conversation, rewindSdk);

    try {
      await runTurns(session, 1);
      // A steered message opens no turn: Claude Code records it as a queued_command attachment
      // under the uuid Paseo minted for it, hung off the entry it was read after.
      const projectDir = await claudeProjectDir(process.cwd(), { configDir });
      mkdirSync(projectDir, { recursive: true });
      const entries = [
        { type: "user", uuid: conversation.userMessageIds[0], parentUuid: null },
        { type: "assistant", uuid: "assistant-1", parentUuid: conversation.userMessageIds[0] },
        { type: "user", uuid: "tool-result-1", parentUuid: "assistant-1" },
        {
          type: "attachment",
          uuid: "queued-command-1",
          parentUuid: "tool-result-1",
          attachment: { type: "queued_command", source_uuid: "steered-message-1" },
        },
      ];
      writeFileSync(
        path.join(projectDir, `${SESSION_ID}.jsonl`),
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      );

      await session.revertConversation?.({ messageId: "steered-message-1" });
    } finally {
      await session.close();
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      }
      rmSync(configDir, { recursive: true, force: true });
    }

    expect(rewindSdk.recordedForks).toEqual([{ upToMessageId: "tool-result-1" }]);
  });
});
