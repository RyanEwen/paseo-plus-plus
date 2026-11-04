import { WorkspaceAutoName } from "../workspace-auto-name.js";
import { execFileSync } from "node:child_process";
import type { z } from "zod";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { WebSocket } from "ws";
import {
  SessionInboundMessageSchema,
  WSOutboundMessageSchema,
  CreationSnapshotSchema,
} from "@getpaseo/protocol/messages";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import pino from "pino";
import type { CreationSnapshot, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function createCreationDaemon(options: Parameters<typeof createTestPaseoDaemon>[0] = {}) {
  const agentClients = options.agentClients ?? createTestAgentClients();
  return createTestPaseoDaemon({
    ...options,
    agentClients,
    // Installed provider CLIs must not change when background naming starts.
    providerOverrides: Object.fromEntries(
      BUILTIN_PROVIDER_IDS.map((id) => [id, { enabled: id in agentClients }]),
    ),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("creation progresses before agent readiness and continues after the disconnected Session is cleaned up", async () => {
  const provider = deferred<void>();
  const ready = deferred<CreationSnapshot>();
  const disconnected = deferred<void>();
  const cleaned = deferred<void>();
  const directory = await mkdtemp(join(tmpdir(), "creation-wire-"));
  let agents = 0;
  let prompts = 0;
  const daemon = await createCreationDaemon({
    logger: pino(
      { level: "trace" },
      {
        write(line) {
          const { msg } = JSON.parse(line);
          if (msg === "Client disconnected; waiting for reconnect") disconnected.resolve();
          if (msg === "agent.session.lifecycle.cleanup") cleaned.resolve();
        },
      },
    ),
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (config.internal) return;
        agents++;
        await provider.promise;
      },
      onStartTurn: (_prompt, config) => {
        if (config.internal) return;
        prompts++;
      },
    }),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.7.2",
    clientId: "creation-subscriber",
  });
  const observer = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.7.2",
    clientId: "creation-independent-observer",
  });
  const observerMessages: SessionOutboundMessage[] = [];
  const unsubscribe = observer.subscribeRawMessages((message) => observerMessages.push(message));
  const workspaceId = "wks_0123456789abcdef";
  const agentId = randomUUID();
  const request = {
    idempotencyKey: "workspace-one",
    workspaceId,
    source: { kind: "directory" as const, path: directory },
    agent: {
      agentId,
      provider: "codex",
      cwd: directory,
      initialPrompt: "Create once",
      clientMessageId: "initial-one",
    },
  };
  try {
    await client.connect();
    await observer.connect();
    const first = client.createWorkspace({
      ...request,
      onEvent: (snapshot) => {
        if (snapshot.phase === "workspace_ready") ready.resolve(snapshot);
      },
    });
    void first.catch(() => undefined);
    const snapshot = await ready.promise;
    expect(snapshot).toMatchObject({ workspaceId, agentId, phase: "workspace_ready" });
    expect((await observer.fetchAgents()).entries).toHaveLength(0);
    expect(
      observerMessages.filter((message) => message.type === "workspace.create.update"),
    ).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await client.close();
    await disconnected.promise;
    await vi.advanceTimersByTimeAsync(90_000);
    await cleaned.promise;
    vi.useRealTimers();
    await expect(first).rejects.toThrow("closed");
    // A disconnected form cannot prevent the provider or initial prompt from starting.
    provider.resolve();
    await expect.poll(() => prompts).toBe(1);
    const replay = await observer.createWorkspace(request);
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(workspaceId);
    expect(replay.agent?.id).toBe(agentId);
    expect(replay.agent?.title).toBe("Create once");
    expect(agents).toBe(1);
    expect(prompts).toBe(1);
    const conflict = await observer.createWorkspace({
      ...request,
      idempotencyKey: "another-intent",
    });
    expect(conflict.error).toBe("workspace_id_conflict");
    expect(agents).toBe(1);
  } finally {
    vi.useRealTimers();
    provider.resolve();
    unsubscribe();
    await client.close();
    await observer.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

async function connectCreationPeer(port: number) {
  const timeout = 30_000;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: SessionOutboundMessage[] = [];
  socket.on("message", (data) => {
    const frame = WSOutboundMessageSchema.parse(JSON.parse(data.toString()));
    if (frame.type === "session") frames.push(frame.message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      clientType: "browser",
      clientId: randomUUID(),
      protocolVersion: 1,
      appVersion: "0.8.0",
    }),
  );
  await expect
    .poll(() => frames.some((m) => m.type === "status" && m.payload.status === "server_info"), {
      timeout,
    })
    .toBe(true);
  return {
    close: () => socket.close(),
    request: async (
      message: z.input<typeof SessionInboundMessageSchema> & { requestId: string },
    ) => {
      socket.send(JSON.stringify({ type: "session", message }));
      const response = () =>
        frames.find(
          (m) =>
            "payload" in m && "requestId" in m.payload && m.payload.requestId === message.requestId,
        );
      await expect.poll(response, { timeout }).toBeDefined();
      return response()!;
    },
  };
}

test.each([false, true])(
  "workspace identity does not depend on subscribing (first subscribe=%s)",
  async (subscribe) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-identity-"));
    const daemon = await createCreationDaemon();
    const peer = await connectCreationPeer(daemon.port);
    try {
      const request = {
        type: "workspace.create.request" as const,
        source: { kind: "directory" as const, path: directory },
        idempotencyKey: "same-workspace",
      };
      const first = await peer.request({ ...request, requestId: "first", subscribe });
      const replay = await peer.request({ ...request, requestId: "replay", subscribe: !subscribe });
      if (first.type !== "workspace.create.response" || replay.type !== "workspace.create.response")
        throw new Error("Expected workspace responses");
      expect(first.payload.error).toBeNull();
      expect(replay.payload.error).toBeNull();
      expect(replay.payload.workspace?.id).toBe(first.payload.workspace?.id);
    } finally {
      peer.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60000,
);

test.each(["create_agent_request", "agent.create.request"] as const)(
  "legacy and modern agent RPCs share one creation identity (first %s)",
  async (type) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-agent-identity-"));
    let creations = 0;
    const daemon = await createCreationDaemon({
      agentClients: createTestAgentClients({
        beforeCreateSession: async (config) => {
          if (config.internal) return;
          creations++;
          // A real provider or Git checkout may take longer than Vitest's default 1s poll budget.
          await new Promise((resolve) => setTimeout(resolve, 1_200));
        },
      }),
    });
    const peer = await connectCreationPeer(daemon.port);
    try {
      const request = {
        config: { provider: "codex", cwd: directory },
        idempotencyKey: "same-agent",
      };
      const first = await peer.request({ ...request, type, requestId: "first" });
      const replay = await peer.request({
        ...request,
        type: type === "agent.create.request" ? "create_agent_request" : "agent.create.request",
        requestId: "replay",
      });
      const createdAgent = (message: SessionOutboundMessage) => {
        if (message.type === "agent.create.response") {
          expect(message.payload.error).toBeNull();
          return message.payload.agent;
        }
        if (message.type === "status" && message.payload.status === "agent_created")
          return message.payload.agent;
        throw new Error(`Unexpected creation result ${JSON.stringify(message)}`);
      };
      expect(createdAgent(replay)?.id).toBe(createdAgent(first)?.id);
      const agentId = createdAgent(first)!.id;
      await daemon.daemon.agentManager.setTitle(agentId, "Updated after creation");
      await daemon.daemon.agentManager.flush();
      const legacyReplay = await peer.request({
        ...request,
        type: "create_agent_request",
        requestId: "legacy-after-update",
      });
      expect(createdAgent(legacyReplay)?.title).toBe("Updated after creation");
      expect(creations).toBe(1);
    } finally {
      peer.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60000,
);

test("legacy keyed creation preserves checkout error codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creation-checkout-error-"));
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: directory, stdio: "pipe" },
  );
  const daemon = await createCreationDaemon({ agentClients: createTestAgentClients() });
  const peer = await connectCreationPeer(daemon.port);
  try {
    const result = await peer.request({
      type: "create_agent_request",
      requestId: "missing-branch",
      idempotencyKey: "missing-branch",
      config: { provider: "codex", cwd: directory },
      worktree: { mode: "checkout-branch", branch: "does-not-exist" },
    });
    expect(result).toMatchObject({
      type: "status",
      payload: { status: "agent_create_failed", errorCode: "unknown_branch" },
    });
  } finally {
    peer.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

test.each(["agent", "workspace"] as const)(
  "%s creation succeeds when the provider rejects its initial prompt",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-prompt-rejected-"));
    const rejection = "Input exceeds the maximum length of 1048576 characters.";
    let sessions = 0;
    let prompts = 0;
    const daemon = await createCreationDaemon({
      agentClients: createTestAgentClients({
        beforeCreateSession: async (config) => {
          if (config.internal) return;
          sessions++;
        },
        onStartTurn: (_prompt, config) => {
          if (config.internal) return;
          prompts++;
          throw new Error(rejection);
        },
      }),
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.11.1",
    });
    const snapshots: CreationSnapshot[] = [];
    const agent = {
      config: { provider: "codex", cwd: directory },
      initialPrompt: "Continue the attached conversation.",
      clientMessageId: "draft:initial-message",
    };
    const streamed: AgentTimelineItem[] = [];
    const unsubscribe = daemon.daemon.agentManager.subscribe((event) => {
      if (event.type === "agent_stream" && event.event.type === "timeline") {
        streamed.push(event.event.item);
      }
    });
    try {
      await client.connect();
      const submit = async () => {
        const common = {
          idempotencyKey: "rejected-first-prompt",
          onEvent: (snapshot: CreationSnapshot) => snapshots.push(snapshot),
        };
        if (kind === "agent") return client.createAgent({ ...common, ...agent });
        const result = await client.createWorkspace({
          ...common,
          source: { kind: "directory", path: directory },
          agent,
        });
        expect(result.error).toBeNull();
        return result.agent!;
      };
      const created = await submit();
      expect(created).toMatchObject({ status: "error", lastError: rejection });
      expect(snapshots.map((snapshot) => snapshot.phase)).not.toContain("prompt_started");
      expect(snapshots.at(-1)).toMatchObject({
        phase: "completed",
        error: null,
        agent: { id: created.id },
      });
      const expectedTimeline = [
        {
          type: "user_message",
          text: agent.initialPrompt,
          clientMessageId: agent.clientMessageId,
          messageId: agent.clientMessageId,
        },
        { type: "assistant_message", text: `[System Error] ${rejection}` },
      ];
      expect(
        (await client.fetchAgentTimeline(created.id)).entries.map((entry) => entry.item),
      ).toEqual(expectedTimeline);
      expect(streamed).toEqual(expectedTimeline);
      expect((await submit()).id).toBe(created.id);
      expect(
        (await client.fetchAgentTimeline(created.id)).entries.map((entry) => entry.item),
      ).toEqual(expectedTimeline);
      expect((await client.fetchAgents()).entries).toHaveLength(1);
      expect({ sessions, prompts }).toEqual({ sessions: 1, prompts: 1 });
    } finally {
      unsubscribe();
      await client.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60000,
);

test("combined worktree and agent creation owns setup on the workspace and replays one identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-owned-setup-"));
  const daemon = await createCreationDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await initializeSetupRepository(directory);
    await client.connect();
    const input = {
      idempotencyKey: "combined-workspace-setup",
      source: { kind: "worktree" as const, cwd: directory, worktreeSlug: "combined-setup" },
      agent: { config: { provider: "codex", cwd: directory } },
    };
    const first = await client.createWorkspace(input);
    const replay = await client.createWorkspace(input);
    expect(first.error).toBeNull();
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(first.workspace?.id);
    expect(replay.agent?.id).toBe(first.agent?.id);
    if (!first.workspace || !first.agent) throw new Error("Expected combined creation resources");
    const observation = client.observeWorkspaceSetup(first.workspace.id);
    await observation.ready;
    await expect
      .poll(async () => (await client.fetchWorkspaceSetupStatus(first.workspace!.id)).snapshot, {
        timeout: 10000,
      })
      .toMatchObject({
        status: "completed",
        detail: {
          log: "",
          commands: [
            expect.objectContaining({
              log: expect.stringContaining("workspace setup output\n"),
              status: "completed",
            }),
          ],
        },
      });
    await observation.release();
    expect(await readFile(join(first.workspace.workspaceDirectory!, "setup-runs"), "utf8")).toBe(
      "once\n",
    );
    const timeline = await client.fetchAgentTimeline(first.agent.id);
    expect(
      timeline.entries.map((entry) => entry.item).filter((item) => item.type === "tool_call"),
    ).toEqual([]);
    expect(first.agent.workspaceId).toBe(first.workspace.id);
    const conflict = await client.createWorkspace({
      ...input,
      source: { ...input.source, worktreeSlug: "different-intent" },
    });
    expect(conflict.error).toBe("workspace_request_key_conflict");
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

test.each(["create_agent_request", "agent.create.request"] as const)(
  "%s rejects agent worktree placement at the wire boundary",
  async (type) => {
    const directory = await mkdtemp(join(tmpdir(), "agent-worktree-rejected-"));
    const daemon = await createCreationDaemon();
    const peer = await connectCreationPeer(daemon.port);
    try {
      for (const placement of [{ git: { createWorktree: true } }, { worktreeName: "legacy" }]) {
        const response = await peer.request({
          type,
          requestId: randomUUID(),
          config: { provider: "codex", cwd: directory },
          ...placement,
        });
        if (response.type !== "agent.create.response" && response.type !== "status")
          throw new Error("Expected agent creation response");
        const error = response.payload.error;
        expect(error).toContain("createWorkspace");
      }
    } finally {
      peer.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function initializeSetupRepository(directory: string): Promise<void> {
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "pipe" });
  await writeFile(
    join(directory, "paseo.json"),
    JSON.stringify({
      worktree: {
        setup: [
          "node -e \"require('fs').appendFileSync('setup-runs', 'once\\n'); console.log('workspace setup output')\"",
        ],
      },
    }),
  );
  execFileSync("git", ["add", "paseo.json"], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "setup fixture",
    ],
    { cwd: directory, stdio: "pipe" },
  );
}

test("Hub-shaped keyed agent worktree creation uses workspace setup and preserves resource identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "keyed-agent-workspace-setup-"));
  const daemon = await createCreationDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const peer = await connectCreationPeer(daemon.port);
  try {
    await initializeSetupRepository(directory);
    await client.connect();
    const input = {
      type: "create_agent_request" as const,
      idempotencyKey: "keyed-agent-worktree",
      config: { provider: "codex", cwd: directory },
      worktree: { mode: "branch-off" as const, newBranch: "keyed-agent-setup", base: "main" },
    };
    const first = await peer.request({ ...input, requestId: "first" });
    const replay = await peer.request({ ...input, requestId: "replay" });
    if (
      first.type !== "status" ||
      first.payload.status !== "agent_created" ||
      replay.type !== "status" ||
      replay.payload.status !== "agent_created"
    )
      throw new Error("Expected agent creation responses");
    expect(replay.payload.agent.id).toBe(first.payload.agent.id);
    expect(replay.payload.agent.workspaceId).toBe(first.payload.agent.workspaceId);
    const agent = first.payload.agent;
    if (!agent.workspaceId) throw new Error("Expected agent workspace ownership");
    await expect
      .poll(async () => (await client.fetchWorkspaceSetupStatus(agent.workspaceId!)).snapshot, {
        timeout: 10000,
      })
      .toMatchObject({
        status: "completed",
        detail: {
          log: "",
          commands: [
            expect.objectContaining({ log: expect.stringContaining("workspace setup output\n") }),
          ],
        },
      });
    expect(await readFile(join(agent.cwd, "setup-runs"), "utf8")).toBe("once\n");
    expect(
      (await client.fetchAgentTimeline(agent.id)).entries
        .map((entry) => entry.item)
        .filter((item) => item.type === "tool_call"),
    ).toEqual([]);
    const conflict = await peer.request({
      ...input,
      requestId: "conflict",
      worktree: { ...input.worktree, newBranch: "different-intent" },
    });
    expect(conflict).toMatchObject({
      type: "status",
      payload: { status: "agent_create_failed", error: "agent_request_key_conflict" },
    });
  } finally {
    peer.close();
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60000);

test.each(["agent", "workspace", "existing-workspace"] as const)(
  "keyed %s retry after a session-open failure preserves hidden intent and workspace",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "creation-safe-retry-"));
    const pluginDirectory = join(directory, "plugin");
    await mkdir(pluginDirectory);
    await writeFile(
      join(pluginDirectory, "paseo-plugin.json"),
      JSON.stringify({ id: "creation-safe-retry", requirements: { paseo: ">=0.14.0-beta.2" } }),
    );
    await writeFile(
      join(pluginDirectory, "index.server.ts"),
      `
export default function contribute(server) {
  let failed = false;
  return server.addHook("agent.open.before", ({ request }) => {
    if (request.workspaceId === null || request.purpose !== "interactive" || request.reason !== "create" || failed) return request;
    failed = true;
    throw new Error("wire pre-dispatch startup failure");
  });
}`,
    );
    let sessions = 0;
    let prompts = 0;
    const naming = vi.spyOn(WorkspaceAutoName.prototype, "scheduleForDirectory");
    const daemon = await createCreationDaemon({
      pluginsEnabled: true,
      plugins: {
        "creation-safe-retry": { source: "directory", path: pluginDirectory, enabled: true },
      },
      agentClients: createTestAgentClients({
        beforeCreateSession: async (config) => {
          if (!config.internal) sessions++;
        },
        onStartTurn: (_prompt, config) => {
          if (!config.internal) prompts++;
        },
      }),
    });
    let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const agentId = randomUUID();
    const workspaceId = "wks_0123456789abcdef";
    const snapshots: CreationSnapshot[] = [];
    const agentInput = {
      agentId,
      provider: "codex",
      cwd: directory,
      env: { RETRY_ROUTE: "original" },
      initialPrompt: "Start once after the hook recovers",
      clientMessageId: "same-initial-prompt",
    };
    const submit = () =>
      kind !== "workspace"
        ? client.createAgent({
            ...agentInput,
            workspaceId: kind === "existing-workspace" ? workspaceId : undefined,
            idempotencyKey: "wire-safe-retry",
            onEvent: (snapshot) => snapshots.push(snapshot),
          })
        : client.createWorkspace({
            workspaceId,
            source: { kind: "directory", path: directory },
            agent: agentInput,
            idempotencyKey: "wire-safe-retry",
            onEvent: (snapshot) => snapshots.push(snapshot),
          });
    try {
      await client.connect();
      await expect
        .poll(async () =>
          (await client.listPlugins()).find(({ id }) => id === "creation-safe-retry"),
        )
        .toMatchObject({ enabled: true, status: "running" });
      if (kind === "existing-workspace") {
        expect(
          await client.createWorkspace({
            workspaceId,
            source: { kind: "directory", path: directory },
          }),
        ).toMatchObject({ error: null, workspace: { id: workspaceId } });
      }
      if (kind !== "workspace")
        await expect(submit()).rejects.toThrow("wire pre-dispatch startup failure");
      else
        expect(await submit()).toMatchObject({
          error:
            "Plugin creation-safe-retry agent.open.before failed: wire pre-dispatch startup failure",
          agent: undefined,
        });
      const intention = await daemon.daemon.agentStorage.get(agentId, {
        includeHistoryIntents: true,
      });
      expect(intention).toMatchObject({
        launchEnv: { RETRY_ROUTE: "original" },
        providerHistory: { origin: "created", registration: "intent", sessionId: null },
      });
      expect(await daemon.daemon.agentStorage.get(agentId)).toBeNull();
      const workspacesBefore = (await client.fetchWorkspaces()).entries;
      expect(workspacesBefore).toHaveLength(1);
      expect({ sessions, prompts }).toEqual({ sessions: 0, prompts: 0 });
      const namingForOriginalWorkspace = () =>
        naming.mock.calls.filter(([input]) => input.workspaceId === intention!.workspaceId);
      expect(namingForOriginalWorkspace()).toHaveLength(kind === "workspace" ? 1 : 0);
      // A new Session must recover the durable same-key receipt, not a closure-local bypass.
      await client.close();
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      const retried = await submit();
      const expectedAgent = { id: agentId, workspaceId: intention!.workspaceId };
      if (kind === "workspace") expect(retried).toMatchObject({ agent: expectedAgent });
      else expect(retried).toMatchObject(expectedAgent);
      expect((await client.fetchWorkspaces()).entries.map((entry) => entry.id)).toEqual(
        workspacesBefore.map((entry) => entry.id),
      );
      expect((await client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual([
        agentId,
      ]);
      expect({ sessions, prompts }).toEqual({ sessions: 1, prompts: 1 });
      expect(namingForOriginalWorkspace()).toHaveLength(kind === "existing-workspace" ? 0 : 1);
      await submit();
      expect({ sessions, prompts }).toEqual({ sessions: 1, prompts: 1 });
      expect(namingForOriginalWorkspace()).toHaveLength(kind === "existing-workspace" ? 0 : 1);
      expect(snapshots.at(-1)).toMatchObject({
        phase: "completed",
        agent: { id: agentId },
        workspaceId: intention!.workspaceId,
      });
    } finally {
      naming.mockRestore();
      await client.close();
      await daemon.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  60_000,
);

test("a keyed SDK dispatch failure remains unknown across Session reconnect without another native call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creation-unknown-retry-"));
  let sessions = 0;
  const daemon = await createCreationDaemon({
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (config.internal) return;
        sessions++;
        throw new Error("SDK may have allocated an external session");
      },
    }),
  });
  let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const request = {
    provider: "codex",
    cwd: directory,
    idempotencyKey: "unknown-dispatch",
    agentId: randomUUID(),
  };
  try {
    await client.connect();
    await expect(client.createAgent(request)).rejects.toThrow(
      "SDK may have allocated an external session",
    );
    await client.close();
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await expect(client.createAgent(request)).rejects.toThrow(
      "SDK may have allocated an external session",
    );
    expect(sessions).toBe(1);
    expect(await daemon.daemon.agentStorage.get(request.agentId)).toBeNull();
    expect(
      await daemon.daemon.agentStorage.get(request.agentId, { includeHistoryIntents: true }),
    ).toMatchObject({ providerHistory: { registration: "intent", sessionId: null } });
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60_000);

test("legacy worktree-target retry does not reprovision after failed startup cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creation-worktree-retry-"));
  await initializeSetupRepository(directory);
  const pluginDirectory = join(directory, "failure-plugin");
  await mkdir(pluginDirectory);
  await writeFile(
    join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "worktree-failure", requirements: { paseo: ">=0.14.0-beta.2" } }),
  );
  await writeFile(
    join(pluginDirectory, "index.server.ts"),
    `export default function(server) {
    return server.addHook("agent.open.before", ({ request }) => {
      if (request.workspaceId !== null && request.purpose === "interactive" && request.reason === "create") throw new Error("worktree startup failed before dispatch");
      return request;
    });
  }`,
  );
  let sessions = 0;
  const daemon = await createCreationDaemon({
    pluginsEnabled: true,
    plugins: { "worktree-failure": { source: "directory", path: pluginDirectory, enabled: true } },
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (!config.internal) sessions++;
      },
    }),
  });
  const peer = await connectCreationPeer(daemon.port);
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const input = {
    type: "create_agent_request" as const,
    idempotencyKey: "legacy-worktree-retry",
    config: { provider: "codex", cwd: directory },
    worktree: { mode: "branch-off" as const, newBranch: "failed-worktree", base: "main" },
    autoArchive: true,
  };
  try {
    await client.connect();
    await expect
      .poll(async () =>
        (await client.listPlugins()).find(({ id: pluginId }) => pluginId === "worktree-failure"),
      )
      .toMatchObject({ enabled: true, status: "running" });
    expect(await peer.request({ ...input, requestId: "first" })).toMatchObject({
      type: "status",
      payload: {
        status: "agent_create_failed",
        error:
          "Plugin worktree-failure agent.open.before failed: worktree startup failed before dispatch",
      },
    });
    const readOwnReceipt = async () => {
      const records = await Promise.all(
        (await readdir(join(daemon.paseoHome, "creations")))
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => {
            const record = JSON.parse(
              await readFile(join(daemon.paseoHome, "creations", name), "utf8"),
            );
            return {
              snapshot: CreationSnapshotSchema.parse(record.snapshot),
              preDispatchAgentFailure: record.preDispatchAgentFailure,
            };
          }),
      );
      const matching = records.filter(
        (record) =>
          record.snapshot.kind === "agent" &&
          record.snapshot.idempotencyKey === input.idempotencyKey,
      );
      expect(matching).toHaveLength(1);
      return matching[0]!;
    };
    const firstReceipt = await readOwnReceipt();
    const assignedAgentId = firstReceipt.snapshot.agentId;
    const originalWorkspaceId = firstReceipt.snapshot.workspaceId;
    if (assignedAgentId === null || originalWorkspaceId === null)
      throw new Error("Expected canonical reserved creation identities");
    expect(assignedAgentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(originalWorkspaceId).toMatch(/^wks_[0-9a-f]{16}$/);
    const original = structuredClone(
      await daemon.daemon.agentStorage.get(assignedAgentId, { includeHistoryIntents: true }),
    );
    expect(original).toMatchObject({
      id: assignedAgentId,
      workspaceId: originalWorkspaceId,
      providerHistory: { origin: "created", registration: "intent", sessionId: null },
    });
    const before = {
      worktrees: execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: directory,
        encoding: "utf8",
      }),
      workspaces: (await client.fetchWorkspaces()).entries,
    };
    const retry = await peer.request({ ...input, requestId: "retry" });
    expect(retry).toMatchObject({
      type: "status",
      payload: {
        status: "agent_create_failed",
        error: expect.stringMatching(/original workspace|cannot retry after cleanup/),
      },
    });
    expect({
      worktrees: execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: directory,
        encoding: "utf8",
      }),
      workspaces: (await client.fetchWorkspaces()).entries,
    }).toEqual(before);
    expect(
      await daemon.daemon.agentStorage.get(assignedAgentId, { includeHistoryIntents: true }),
    ).toEqual(original);
    expect(sessions).toBe(0);
    const receipt = await readOwnReceipt();
    expect(receipt.snapshot.revision).toBeGreaterThan(firstReceipt.snapshot.revision);
    expect(receipt).toMatchObject({
      snapshot: {
        kind: "agent",
        idempotencyKey: input.idempotencyKey,
        agentId: assignedAgentId,
        workspaceId: originalWorkspaceId,
        failedStage: "agent",
        outcomeUnknown: true,
      },
    });
    expect(receipt.preDispatchAgentFailure).toBeUndefined();
  } finally {
    peer.close();
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60_000);
