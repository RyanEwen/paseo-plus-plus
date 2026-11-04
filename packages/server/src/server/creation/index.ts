import type { Logger } from "pino";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CreationSnapshotSchema,
  type AgentSnapshotPayload,
  type CreationSnapshot,
  type WorkspaceDescriptorPayload,
} from "@getpaseo/protocol/messages";
import { writeFileAtomic } from "../atomic-file.js";
import { generateWorkspaceId } from "../workspace-registry-model.js";

type Observer = (snapshot: CreationSnapshot) => void;
export interface CreatedAgent {
  agent: AgentSnapshotPayload;
  initialPromptStarted: boolean;
}
/** Internal callback authority; never accepted from a request or persisted in a public snapshot. */
export interface CreationAgentAttempt {
  readonly retryHistoryIntent: boolean;
  acknowledgeManager(agentId: string): void;
  markProviderDispatch(agentId: string): void;
  certifyHistoryIntentReservation(agentId: string, workspaceId: string | undefined): void;
  resolveRetryWorkspaceId(agentId: string): string;
  consumeHistoryRetry(agentId: string): void;
}

function createAgentAttempt(
  agentId: string,
  retryHistoryIntent: boolean,
  originalWorkspaceId: string | null,
  assertCurrent: () => void,
) {
  let live = true;
  let acknowledged = false;
  let dispatched = false;
  let ownsIntent = false;
  let reservedWorkspaceId: string | undefined;
  let consumed = false;
  const assertLive = (id: string) => {
    if (!live || id !== agentId)
      throw new Error("Creation attempt is expired or has another agent ID");
    assertCurrent();
  };
  const context: CreationAgentAttempt = Object.freeze({
    retryHistoryIntent,
    acknowledgeManager(id: string) {
      assertLive(id);
      if (acknowledged) throw new Error("Creation attempt already entered its manager");
      acknowledged = true;
    },
    certifyHistoryIntentReservation(id: string, workspaceId: string | undefined) {
      assertLive(id);
      if (
        !acknowledged ||
        dispatched ||
        ownsIntent ||
        (originalWorkspaceId !== null && originalWorkspaceId !== workspaceId)
      )
        throw new Error("Creation intent ownership is not admitted");
      reservedWorkspaceId = workspaceId;
      ownsIntent = true;
    },
    resolveRetryWorkspaceId(id: string) {
      assertLive(id);
      if (!retryHistoryIntent || acknowledged || dispatched || !originalWorkspaceId)
        throw new Error("Creation retry placement is not admitted");
      return originalWorkspaceId;
    },
    markProviderDispatch(id: string) {
      assertLive(id);
      if (!acknowledged || dispatched)
        throw new Error("Creation provider dispatch is not admitted");
      dispatched = true;
    },
    consumeHistoryRetry(id: string) {
      assertLive(id);
      if (!acknowledged || dispatched || !retryHistoryIntent || consumed)
        throw new Error("Creation history retry is not admitted");
      consumed = true;
    },
  });
  return {
    context,
    finish() {
      live = false;
    },
    get acknowledged() {
      return acknowledged;
    },
    get ownsIntent() {
      return ownsIntent;
    },
    get workspaceId() {
      return reservedWorkspaceId;
    },
    get dispatched() {
      return dispatched;
    },
  };
}
interface CreationRequest {
  key: string;
  request: { [key: string]: unknown };
  workspaceId?: string;
  agentId?: string;
  hasAgent: boolean;
  hasPrompt: boolean;
  exists: (kind: "workspace" | "agent", id: string) => Promise<boolean>;
  provision?: (
    workspaceId: string,
  ) => Promise<{ workspace: WorkspaceDescriptorPayload; setupSkippedReason?: string }>;
  createAgent?: (
    agentId: string,
    workspace: WorkspaceDescriptorPayload | undefined,
    onReady: (agent: AgentSnapshotPayload) => Promise<void>,
    attempt: CreationAgentAttempt,
  ) => Promise<CreatedAgent>;
}
export type CreationInput = CreationRequest &
  (
    | { kind: "workspace" }
    | { kind: "agent"; readAgent: (id: string) => Promise<AgentSnapshotPayload | null> }
  );
const RecordSchema = z.object({
  fingerprint: z.string(),
  snapshot: CreationSnapshotSchema,
  inFlight: z.enum(["workspace", "agent", "prompt"]).nullable(),
  preDispatchAgentFailure: z.boolean().optional(),
});
type Record = z.infer<typeof RecordSchema>;

function isUnclassifiedAgentFailure(record: Record | null): record is Record {
  return (
    record?.snapshot.phase === "failed" &&
    record.snapshot.failedStage === "agent" &&
    record.preDispatchAgentFailure !== true
  );
}

function isSafeHistoryRetry(record: Record | null): boolean {
  return (
    record?.preDispatchAgentFailure === true &&
    record.snapshot.phase === "failed" &&
    record.snapshot.failedStage === "agent" &&
    record.snapshot.outcomeUnknown === false &&
    record.inFlight === null &&
    !record.snapshot.agent
  );
}

function creationFailureCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function hasUnknownCreationEffects(
  stage: NonNullable<Record["inFlight"]>,
  rejectedBeforeProvision: boolean,
  attempt: ReturnType<typeof createAgentAttempt> | undefined,
): boolean {
  return (
    stage === "prompt" ||
    (stage === "workspace" && !rejectedBeforeProvision) ||
    (stage === "agent" && (!attempt?.acknowledged || !attempt.ownsIntent || attempt.dispatched))
  );
}

function isSafeOwnedCreationFailure(
  record: Record,
  stage: NonNullable<Record["inFlight"]>,
  unknown: boolean,
  attempt: ReturnType<typeof createAgentAttempt> | undefined,
): boolean {
  return (
    stage === "agent" &&
    !unknown &&
    attempt?.acknowledged === true &&
    attempt.ownsIntent &&
    !attempt.dispatched &&
    !record.snapshot.agent
  );
}

/** Owns creation across socket lifetimes. Resource owners perform work; this module commits its milestones. */
export class CreationService {
  private admission: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, Promise<CreationSnapshot>>();
  private readonly receiptOperations = new Map<string, Promise<void>>();
  private readonly observers = new Map<string, Set<Observer>>();
  constructor(
    private readonly directory: string,
    private readonly logger: Logger,
    private readonly validateCompleted: (
      snapshot: CreationSnapshot,
    ) => Promise<void> = async () => {},
    private readonly legacyDirectory?: string,
  ) {}

  async create(input: CreationInput, observer?: Observer): Promise<CreationSnapshot> {
    const identity = identityFor(input.kind, input.key);
    const admitted = this.admission.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const fingerprint = digest(input.request);
      let record = await this.read(identity);
      if (!record) record = await this.readLegacyAgent(input, fingerprint);
      if (record && record.fingerprint !== fingerprint)
        throw new Error(`${input.kind}_request_key_conflict`);
      const running = this.active.get(identity);
      if (running && record) return { completion: running, snapshot: record.snapshot };
      if (record?.snapshot.phase === "completed") await this.validateCompleted(record.snapshot);
      if (record?.snapshot.phase === "completed" || record?.snapshot.outcomeUnknown) {
        if (record.preDispatchAgentFailure !== undefined) {
          record.preDispatchAgentFailure = undefined;
          await this.write(identity, record);
        }
        return { completion: Promise.resolve(record.snapshot), snapshot: record.snapshot };
      }
      if (record?.inFlight) {
        record.preDispatchAgentFailure = undefined;
        await this.publish(identity, record, {
          phase: "failed",
          error: `${input.kind}_request_outcome_unknown`,
          failedStage: record.inFlight,
          outcomeUnknown: true,
        });
        return { completion: Promise.resolve(record.snapshot), snapshot: record.snapshot };
      }
      // An old false outcome only proves no published resource was found. A new
      // reservation rejection must never turn that old uncertainty into safe retry proof.
      if (isUnclassifiedAgentFailure(record)) {
        record.preDispatchAgentFailure = undefined;
        await this.publish(identity, record, { outcomeUnknown: true });
        return { completion: Promise.resolve(record.snapshot), snapshot: record.snapshot };
      }
      const retryHistoryIntent = isSafeHistoryRetry(record);
      if (!record) {
        record = initialRecord(input, fingerprint);
        // Persist identity before claiming resources. A failed admission can only retry these IDs.
        await this.write(identity, record);
      }
      await this.claimResources(identity, record.snapshot, input);
      if (retryHistoryIntent) await this.assertRetryAgentAbsent(input, record.snapshot.agentId!);
      if (record.snapshot.phase === "failed") {
        await this.publish(identity, record, {
          phase: record.snapshot.workspace ? "workspace_ready" : "accepted",
          error: null,
          errorCode: undefined,
          failedStage: undefined,
          outcomeUnknown: undefined,
        });
      }
      const snapshot = record.snapshot;
      // Defer the runner until admission has installed the initiating observer.
      const completion: Promise<CreationSnapshot> = Promise.resolve().then(() =>
        this.run(identity, record, input, retryHistoryIntent, () => {
          if (this.active.get(identity) !== completion)
            throw new Error("Creation runner is no longer current");
        }),
      );
      this.active.set(identity, completion);
      void completion
        .finally(() => {
          if (this.active.get(identity) === completion) this.active.delete(identity);
        })
        .catch(() => undefined);
      return { completion, snapshot };
    });
    this.admission = admitted.then(
      () => undefined,
      () => undefined,
    );
    // Install before admission starts, so even a fast local provision cannot outrun observation.
    const unsubscribe = observer ? this.observe(identity, observer) : () => {};
    try {
      const { completion, snapshot } = await admitted;
      if (observer) this.notify(observer, snapshot);
      return await completion;
    } finally {
      unsubscribe();
    }
  }

  async subscribe(
    kind: CreationSnapshot["kind"],
    key: string,
    observer: Observer,
  ): Promise<{ snapshot: CreationSnapshot | null; unsubscribe: () => void }> {
    const identity = identityFor(kind, key);
    const unsubscribe = this.observe(identity, observer);
    try {
      await this.admission;
      const record = await this.read(identity);
      if (record?.inFlight && !this.active.has(identity)) {
        record.preDispatchAgentFailure = undefined;
        await this.publish(identity, record, {
          phase: "failed",
          failedStage: record.inFlight,
          outcomeUnknown: true,
          error: `${kind}_request_outcome_unknown`,
        });
      }
      if (record?.snapshot.phase === "completed") await this.validateCompleted(record.snapshot);
      return { snapshot: record?.snapshot ?? null, unsubscribe };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  private async run(
    identity: string,
    record: Record,
    input: CreationInput,
    retryHistoryIntent: boolean,
    assertCurrent: () => void,
  ): Promise<CreationSnapshot> {
    let attempt: ReturnType<typeof createAgentAttempt> | undefined;
    try {
      if (input.provision && !record.snapshot.workspace) {
        record.inFlight = "workspace";
        await this.write(identity, record);
        const { workspace, setupSkippedReason } = await input.provision(
          record.snapshot.workspaceId!,
        );
        record.inFlight = null;
        await this.publish(identity, record, {
          phase: "workspace_ready",
          workspace,
          workspaceId: workspace.id,
          setupSkippedReason,
        });
      }
      if (input.hasAgent && input.createAgent && !record.snapshot.agent) {
        record.preDispatchAgentFailure = undefined;
        record.inFlight = "agent";
        await this.write(identity, record);
        attempt = createAgentAttempt(
          record.snapshot.agentId!,
          retryHistoryIntent,
          record.snapshot.workspaceId,
          assertCurrent,
        );
        let created: CreatedAgent;
        try {
          created = await input.createAgent(
            record.snapshot.agentId!,
            record.snapshot.workspace,
            async (readyAgent) => {
              record.inFlight = input.hasPrompt ? "prompt" : null;
              await this.publish(identity, record, {
                phase: "agent_ready",
                agent: readyAgent,
                workspaceId: readyAgent.workspaceId ?? record.snapshot.workspaceId,
              });
            },
            attempt.context,
          );
        } finally {
          attempt.finish();
        }
        const { agent, initialPromptStarted } = created;
        record.inFlight = null;
        if (initialPromptStarted)
          await this.publish(identity, record, { phase: "prompt_started", agent });
        else record.snapshot = { ...record.snapshot, agent };
      }
      record.inFlight = null;
      await this.publish(identity, record, { phase: "completed" });
    } catch (error) {
      const stage = record.inFlight ?? "agent";
      const resource: {
        kind: Parameters<CreationInput["exists"]>[0];
        id: CreationSnapshot["agentId"];
      } =
        stage === "workspace"
          ? { kind: "workspace", id: record.snapshot.workspaceId }
          : { kind: "agent", id: record.snapshot.agentId };
      const code = creationFailureCode(error);
      const rejectedBeforeProvision = code === "directory_not_found" || code === "source_required";
      const unknown =
        hasUnknownCreationEffects(stage, rejectedBeforeProvision, attempt) ||
        (resource.id !== null && (await input.exists(resource.kind, resource.id)));
      record.preDispatchAgentFailure = isSafeOwnedCreationFailure(record, stage, unknown, attempt)
        ? true
        : undefined;
      if (!unknown) record.inFlight = null;
      await this.publish(identity, record, {
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
        errorCode: code,
        failedStage: stage,
        outcomeUnknown: unknown,
        ...(record.preDispatchAgentFailure && attempt?.workspaceId
          ? { workspaceId: attempt.workspaceId }
          : {}),
      });
    }
    return record.snapshot;
  }

  // COMPAT(agentRequestReceipts): added in v0.8.0, remove after 2027-03-11 once old creation receipts can expire.
  // Import the previous receipt format; it is never a second execution path.
  private async readLegacyAgent(input: CreationInput, fingerprint: string): Promise<Record | null> {
    if (input.kind !== "agent" || !this.legacyDirectory) return null;
    const text = await readOptional(
      join(this.legacyDirectory, `${digest(["create", input.key])}.json`),
    );
    if (text === null) return null;
    const receipt = z
      .object({
        fingerprint: z.string(),
        state: z.enum(["pending", "completed"]),
        agentId: z.string(),
      })
      .parse(JSON.parse(text));
    if (receipt.fingerprint !== digest({ type: "create_agent_request", ...input.request }))
      throw new Error("agent_request_key_conflict");
    const agent = await input.readAgent(receipt.agentId);
    if (!agent && receipt.state === "completed")
      throw new Error("Previously created agent no longer exists");
    const record = initialRecord({ ...input, agentId: receipt.agentId }, fingerprint);
    record.snapshot = {
      ...record.snapshot,
      phase: agent ? "completed" : "failed",
      agent: agent ?? undefined,
      workspaceId: agent?.workspaceId ?? record.snapshot.workspaceId,
      error: agent ? null : "agent_request_outcome_unknown",
      ...(agent ? {} : { failedStage: "agent", outcomeUnknown: true }),
    };
    await this.write(identityFor(input.kind, input.key), record);
    return record;
  }

  private async assertRetryAgentAbsent(input: CreationInput, agentId: string): Promise<void> {
    if (await input.exists("agent", agentId)) throw new Error("agent_id_conflict");
  }

  private async claimResources(
    identity: string,
    snapshot: CreationSnapshot,
    input: CreationInput,
  ): Promise<void> {
    if (input.kind === "workspace" && snapshot.workspaceId)
      await this.claim(identity, "workspace", snapshot.workspaceId, input.exists);
    if (snapshot.agentId) await this.claim(identity, "agent", snapshot.agentId, input.exists);
  }

  private async claim(
    identity: string,
    kind: "workspace" | "agent",
    id: string,
    exists: CreationInput["exists"],
  ): Promise<void> {
    const file = join(this.directory, `${digest([kind, id])}.claim`);
    const owner = await readOptional(file);
    if (owner !== null) {
      if (owner !== identity) throw new Error(`${kind}_id_conflict`);
      return;
    }
    if (await exists(kind, id)) throw new Error(`${kind}_id_conflict`);
    await writeFile(file, identity, { flag: "wx", mode: 0o600 });
  }
  private observe(identity: string, observer: Observer): () => void {
    const observers = this.observers.get(identity) ?? new Set<Observer>();
    observers.add(observer);
    this.observers.set(identity, observers);
    return () => {
      observers.delete(observer);
      if (!observers.size) this.observers.delete(identity);
    };
  }
  private notify(observer: Observer, snapshot: CreationSnapshot): void {
    try {
      observer(snapshot);
    } catch (err) {
      this.logger.warn(
        {
          err,
          kind: snapshot.kind,
          idempotencyKey: snapshot.idempotencyKey,
          phase: snapshot.phase,
        },
        "Creation observer failed",
      );
    }
  }
  private async publish(
    identity: string,
    record: Record,
    update: Partial<CreationSnapshot>,
  ): Promise<void> {
    if (update.phase !== "failed") record.preDispatchAgentFailure = undefined;
    record.snapshot = { ...record.snapshot, ...update, revision: record.snapshot.revision + 1 };
    await this.write(identity, record);
    for (const observer of this.observers.get(identity) ?? [])
      this.notify(observer, record.snapshot);
  }
  private write(identity: string, record: Record): Promise<void> {
    // Serialize now: the runner mutates the record after queueing this write.
    const contents = JSON.stringify(record, null, 2);
    return this.accessReceipt(identity, () =>
      writeFileAtomic(join(this.directory, `${identity}.json`), contents),
    );
  }
  private read(identity: string): Promise<Record | null> {
    return this.accessReceipt(identity, async () => {
      const text = await readOptional(join(this.directory, `${identity}.json`));
      return text === null ? null : RecordSchema.parse(JSON.parse(text));
    });
  }
  private accessReceipt<T>(identity: string, access: () => Promise<T>): Promise<T> {
    // Admission and the runner progress independently. Keep this owner from
    // holding a receipt read open while atomically replacing the same file.
    const previous = this.receiptOperations.get(identity) ?? Promise.resolve();
    const result = previous.then(access);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.receiptOperations.set(identity, settled);
    void settled.finally(() => {
      if (this.receiptOperations.get(identity) === settled) this.receiptOperations.delete(identity);
    });
    return result;
  }
}
function initialRecord(input: CreationInput, fingerprint: string): Record {
  return {
    fingerprint,
    inFlight: null,
    snapshot: {
      kind: input.kind,
      idempotencyKey: input.key,
      revision: 0,
      phase: "accepted",
      error: null,
      workspaceId: input.workspaceId ?? (input.kind === "workspace" ? generateWorkspaceId() : null),
      agentId: input.hasAgent ? (input.agentId ?? randomUUID()) : null,
    },
  };
}
function identityFor(kind: string, key: string): string {
  return digest([kind, key]);
}
function digest(input: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(input, (_key, value: unknown) => {
        if (value && typeof value === "object" && !Array.isArray(value))
          return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        return value;
      }),
    )
    .digest("hex");
}
async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
