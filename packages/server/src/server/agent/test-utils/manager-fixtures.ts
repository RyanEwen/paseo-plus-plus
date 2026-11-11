/** Shared agent-manager test fixtures: deterministic provider clients, sessions and helpers. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPromptInput,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
  AgentProvider,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent-sdk-types.js";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function drainAsyncGenerator<T>(generator: AsyncGenerator<T>): Promise<void> {
  for await (const _ of generator) {
    // Drain provider events while AgentManager subscribers observe them.
  }
}

export const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

export class TestAgentClient implements AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities = TEST_CAPABILITIES;
  readonly createdConfigs: AgentSessionConfig[] = [];
  readonly resumeOverrides: Array<Partial<AgentSessionConfig> | undefined> = [];

  constructor(provider: AgentProvider = "codex") {
    this.provider = provider;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createdConfigs.push(config);
    return new TestAgentSession(config);
  }

  async fetchCatalog() {
    return {
      models: [
        {
          provider: this.provider,
          id: "gpt-5.4",
          label: "GPT-5.4",
          isDefault: true,
        },
        {
          provider: this.provider,
          id: "gpt-5.4-mini",
          label: "GPT-5.4 Mini",
        },
        {
          provider: this.provider,
          id: "gpt-5.2-codex",
          label: "GPT-5.2 Codex",
        },
      ],
      modes: [],
    };
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.resumeOverrides.push(config);
    return new TestAgentSession({
      provider: this.provider,
      cwd: config?.cwd ?? process.cwd(),
      daemonAppendSystemPrompt: config?.daemonAppendSystemPrompt,
    });
  }
}

export class SessionRecordingAgentClient extends TestAgentClient {
  readonly sessions: TestAgentSession[] = [];

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new TestAgentSession(config);
    this.sessions.push(session);
    return session;
  }
}

export class TestAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private runtimeModel: string | null = null;
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnIdCounter = 0;
  private interrupted = false;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id ?? this.config.provider,
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(): Promise<{ turnId: string }> {
    this.interrupted = false;
    const turnId = `turn-${this.id}-${++this.turnIdCounter}`;
    // Use setTimeout so events arrive after the caller sets up the foreground waiter
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      this.runtimeModel = "gpt-5.2-codex";
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
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // error isolation per design
      }
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.runtimeModel ?? this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(
    _requestId: string,
    _response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {}

  describePersistence() {
    return {
      provider: this.provider,
      sessionId: this.id,
    };
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async close(): Promise<void> {}
}

export class SteeringTestSession extends TestAgentSession {
  interruptCount = 0;
  startCount = 0;
  steerCount = 0;
  steerResult: "accepted" | "unavailable" | Error = "accepted";
  startPrompts: AgentPromptInput[] = [];

  override async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    this.startPrompts.push(prompt);
    const turnId = `active-turn-${++this.startCount}`;
    setTimeout(() => this.pushEvent({ type: "turn_started", provider: this.provider, turnId }), 0);
    return { turnId };
  }

  override async interrupt(): Promise<void> {
    this.interruptCount += 1;
    this.pushEvent({
      type: "turn_canceled",
      provider: this.provider,
      turnId: `active-turn-${this.startCount}`,
    });
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: import("./agent-sdk-types.js").SteerActiveTurnOptions,
  ): Promise<import("./agent-sdk-types.js").SteerResult> {
    this.steerCount += 1;
    if (options.expectedTurnId !== `active-turn-${this.startCount}`) {
      return { status: "unavailable" };
    }
    if (this.steerResult instanceof Error) throw this.steerResult;
    if (this.steerResult === "unavailable") return { status: "unavailable" };
    this.pushEvent({
      type: "timeline",
      provider: this.provider,
      item: {
        type: "user_message",
        text: typeof prompt === "string" ? prompt : "structured",
        clientMessageId: options.clientMessageId,
        messageId: `provider-${options.clientMessageId}`,
      },
    });
    return { status: "accepted" };
  }
}

export class ControlledInterruptSession extends TestAgentSession {
  interruptCalled = false;

  constructor(
    config: AgentSessionConfig,
    readonly turnId: string,
    private readonly interruptBehavior: (session: ControlledInterruptSession) => Promise<void>,
  ) {
    super(config);
  }

  override async startTurn(): Promise<{ turnId: string }> {
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId: this.turnId });
    }, 0);
    return { turnId: this.turnId };
  }

  override async interrupt(): Promise<void> {
    this.interruptCalled = true;
    await this.interruptBehavior(this);
  }
}

export interface ControlledInterruptFixture {
  agentId: string;
  manager: AgentManager;
  session: ControlledInterruptSession;
  startForegroundRun(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createControlledInterruptFixture(options: {
  name: string;
  agentId: string;
  turnId: string;
  interrupt: (session: ControlledInterruptSession) => Promise<void>;
}): Promise<ControlledInterruptFixture> {
  const workdir = mkdtempSync(join(tmpdir(), `agent-manager-${options.name}-`));
  const session = new ControlledInterruptSession(
    { provider: "codex", cwd: workdir },
    options.turnId,
    options.interrupt,
  );
  const client = new (class extends TestAgentClient {
    override async createSession(): Promise<AgentSession> {
      return session;
    }
  })();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: new AgentStorage(join(workdir, "agents"), logger),
    logger,
    rescueTimeouts: { interruptSessionMs: 10 },
    idFactory: () => options.agentId,
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  return {
    agentId: agent.id,
    manager,
    session,
    async startForegroundRun() {
      const run = manager.streamAgent(agent.id, "exercise cancellation");
      void (async () => {
        for await (const _event of run) {
          // Keep the foreground stream subscribed until the controlled turn settles.
        }
      })();
      await manager.waitForAgentRunStart(agent.id);
    },
    async cleanup() {
      await manager.closeAgent(agent.id);
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

export const logger = createTestLogger();
