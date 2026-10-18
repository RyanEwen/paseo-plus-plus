import { requestPromptFixture } from "@/timeline/canonical-prompt-context.test-fixture";
import { canonicalPromptSourceKey } from "./canonical-prompt-context";
import { DatabaseSync } from "node:sqlite";
import { ReplicaCache } from "@/runtime/replica-cache";
import {
  createSqliteReplicaRowStore,
  type ReplicaSqliteConnection,
  type SqliteValue,
} from "@/runtime/replica-cache/row-store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { CachedTimeline } from "@/runtime/replica-cache";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { useCreateFlowStore, type PendingCreateAttempt } from "@/stores/create-flow-store";
import type { StreamItem } from "@/types/stream";
import {
  createTimelineReplica,
  createViewedTimelineOwner,
  type TimelineReplicaStorage,
  type ViewedTimelineOwner,
} from "./viewed-timeline-sync";

const SERVER_ID = "timeline-replica-host";
const AGENT_ID = "agent-1";

function item(id: string, text: string, seq: number): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date("2026-08-26T10:00:00.000Z"),
    timelineCursor: { epoch: "epoch-1", seq },
  };
}

function cachedTimeline(): CachedTimeline {
  return {
    agentId: AGENT_ID,
    items: [item("cached", "cached", 4)],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
    hasOlder: true,
  };
}

function createOwner(
  storage: TimelineReplicaStorage,
  readCursor: () => { epoch: string; endSeq: number } | undefined = () => undefined,
): ViewedTimelineOwner {
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage,
    prepareAgent: async () => undefined,
  });
  return createViewedTimelineOwner({
    serverId: SERVER_ID,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      observe: () => ({ ready: Promise.resolve(), release: async () => undefined }),
      readCursor,
      fetchPage: async () => ({ hasNewer: false, endCursor: null }),
      fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
      reportError: () => undefined,
      schedule: () => () => undefined,
    },
  });
}

function applySynced(agentId: string, seq: number): void {
  useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, agentId, {
    items: [item(`network-${agentId}`, "network", seq)],
    head: [],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: seq },
    older: "available",
    newer: false,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
}

afterEach(() => useSessionStore.getState().clearSession(SERVER_ID));

describe("viewed timeline persistence", () => {
  it("shares an in-flight cache preparation with the viewed owner", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    let reads = 0;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        readTimeline: () => {
          reads += 1;
          return read;
        },
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const routePreparation = replica.prepare(AGENT_ID);
    const ownerPreparation = replica.prepare(AGENT_ID);
    release(cachedTimeline());
    await Promise.all([routePreparation, ownerPreparation]);

    expect(reads).toBe(1);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("paints cached history without claiming authoritative synchronization", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const owner = createOwner({
      readTimeline: async () => cachedTimeline(),
      commitTimeline: () => undefined,
    });

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toEqual({ status: "painted", items: cachedTimeline().items });
    owner.dispose();
  });

  it("reconciles an overlapping projected message against its cached cursor", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const partial = "```mermaid\nflowchart LR\n  Start --> Mid";
    const complete = `${partial}dle\n  Middle --> Done\n\`\`\``;
    const owner = createOwner({
      readTimeline: async () => ({
        agentId: AGENT_ID,
        items: [item("cached", partial, 4)],
        range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
        hasOlder: false,
      }),
      commitTimeline: () => undefined,
    });

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "painted" });

    owner.applyTimelineResponse({
      requestId: "page-after-cache",
      agentId: AGENT_ID,
      agent: null,
      direction: "after",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
      startCursor: { epoch: "epoch-1", seq: 5 },
      endCursor: { epoch: "epoch-1", seq: 5 },
      entries: [
        {
          provider: "mock",
          item: { type: "assistant_message", text: complete },
          timestamp: "2026-08-26T10:00:00.000Z",
          seqStart: 2,
          seqEnd: 5,
          sourceSeqRanges: [{ startSeq: 2, endSeq: 5 }],
          collapsed: ["assistant_merge"],
        },
      ],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    });

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toMatchObject([{ kind: "assistant_message", text: complete }]);
    owner.dispose();
  });

  it("reopens painted live mutations without persisting authoritative coverage", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let durable: CachedTimeline | undefined = cachedTimeline();
    let pending: CachedTimeline | undefined;
    const storage: TimelineReplicaStorage = {
      readTimeline: async () => durable,
      commitTimeline: (_serverId, _agentId, timeline) => {
        pending = timeline;
      },
    };
    const first = createOwner(storage);
    first.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "painted" });

    first.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "live", messageId: "live" },
      } as AgentStreamEventPayload,
      seq: 5,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    first.flushStreamAgent(AGENT_ID);

    expect(pending).toMatchObject({ range: null, hasOlder: false });
    expect(pending?.items.map((entry) => entry.id)).toEqual(["cached", expect.any(String)]);
    durable = pending;
    first.dispose();
    useSessionStore.getState().clearSession(SERVER_ID);
    useSessionStore.getState().initializeSession(SERVER_ID, null);

    const reopened = createOwner(storage);
    reopened.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({
        status: "painted",
        items: [
          expect.objectContaining({ id: "cached" }),
          expect.objectContaining({ text: "live" }),
        ],
      });
    reopened.dispose();
  });

  it("does not let a late cache read overwrite newer network state", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const owner = createOwner({
      readTimeline: () => read,
      commitTimeline: () => undefined,
    });

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    applySynced(AGENT_ID, 8);
    release(cachedTimeline());

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "synced", range: { endSeq: 8 } });
    owner.dispose();
  });

  it("paints cached rows without replacing a live head that arrives during preparation", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const preparation = replica.prepare(AGENT_ID);
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      head: [item("live", "live", 5)],
    });
    release(cachedTimeline());
    await preparation;

    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toEqual({ status: "painted", items: cachedTimeline().items });
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID)).toEqual([
      item("live", "live", 5),
    ]);
  });

  it("reconciles a live head that overlaps the cached canonical timeline", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const preparation = replica.prepare(AGENT_ID);
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      head: [item("cached", "cached", 4), item("live", "live", 5)],
    });
    release(cachedTimeline());
    await preparation;

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toEqual([item("cached", "cached", 4), item("live", "live", 5)]);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("reconciles cached rows with a non-authoritative timeline painted during preparation", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const preparation = replica.prepare(AGENT_ID);
    useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
      items: [item("live", "live", 5)],
      head: [],
      range: null,
      older: "none",
      newer: false,
      synchronized: false,
      acknowledgedClientMessageIds: [],
    });
    release(cachedTimeline());
    await preparation;

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toEqual([item("cached", "cached", 4), item("live", "live", 5)]);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("persists accepted live stream commits through the owner", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    applySynced(AGENT_ID, 8);
    const commits: CachedTimeline[] = [];
    const owner = createOwner({
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, _agentId, timeline) => commits.push(timeline),
    });
    owner.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "live", messageId: "live" },
      } as AgentStreamEventPayload,
      seq: 9,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    owner.flushStreamAgent(AGENT_ID);

    expect(commits.at(-1)?.items.at(-1)).toMatchObject({ text: "live" });
    expect(commits.at(-1)?.range?.endSeq).toBe(9);
    owner.dispose();
  });

  it("applies and persists authoritative pages inside the owner", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const keys: string[] = [];
    const owner = createOwner({
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, agentId) => keys.push(agentId),
    });

    owner.applyTimelineResponse({
      requestId: "page-1",
      agentId: AGENT_ID,
      agent: null,
      direction: "tail",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 },
      startCursor: null,
      endCursor: null,
      entries: [],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    });

    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toMatchObject({ status: "synced" });
    expect(keys).toEqual([AGENT_ID]);
    owner.dispose();
  });

  it("persists demanded agents independently", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const keys: string[] = [];
    const owner = createOwner({
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, agentId) => keys.push(agentId),
    });

    applySynced(AGENT_ID, 8);
    applySynced("agent-2", 3);
    for (const [agentId, seq] of [
      [AGENT_ID, 9],
      ["agent-2", 4],
    ] as const) {
      owner.enqueueStreamEvent(agentId, {
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: agentId, messageId: `live-${agentId}` },
        } as AgentStreamEventPayload,
        seq,
        epoch: "epoch-1",
        timestamp: new Date("2026-08-26T10:00:01.000Z"),
      });
      owner.flushStreamAgent(agentId);
    }

    expect(keys).toEqual([AGENT_ID, "agent-2"]);
    owner.dispose();
  });
});

describe("create handoff lifetime", () => {
  const DRAFT_ID = "draft-1";

  afterEach(() => useCreateFlowStore.getState().clearAll());

  function sentCreateHandoff(): void {
    useCreateFlowStore.getState().setPending({
      draftId: DRAFT_ID,
      serverId: SERVER_ID,
      agentId: AGENT_ID,
      clientMessageId: "client-message-1",
      text: "Create this chat.",
      timestamp: 0,
    });
    useCreateFlowStore.getState().markLifecycle({ draftId: DRAFT_ID, lifecycle: "sent" });
  }

  function createHandoff(): PendingCreateAttempt | undefined {
    return useCreateFlowStore.getState().pendingByDraftId[DRAFT_ID];
  }

  function syncedTailPage(): Parameters<ViewedTimelineOwner["applyTimelineResponse"]>[0] {
    return {
      requestId: "tail-1",
      agentId: AGENT_ID,
      agent: null,
      direction: "tail",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 },
      startCursor: null,
      endCursor: null,
      entries: [],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    };
  }

  interface HeldCatchUpOwner {
    owner: ViewedTimelineOwner;
    release: () => void;
  }

  async function ownerWithHeldCatchUp(): Promise<HeldCatchUpOwner> {
    let releaseTailFetch!: () => void;
    let tailFetchStarted = false;
    const tailFetched = new Promise<void>((resolve) => {
      releaseTailFetch = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: { readTimeline: async () => undefined, commitTimeline: () => undefined },
      prepareAgent: async () => undefined,
    });
    const owner = createViewedTimelineOwner({
      serverId: SERVER_ID,
      replica,
      replaceDemandedAgentIds: () => undefined,
      drainQueuedAgentMessage: () => undefined,
      ports: {
        observe: () => ({ ready: Promise.resolve(), release: async () => undefined }),
        readCursor: () => undefined,
        fetchPage: async () => {
          tailFetchStarted = true;
          await tailFetched;
          return { hasNewer: false, endCursor: null };
        },
        fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
        reportError: () => undefined,
        schedule: () => () => undefined,
      },
    });

    owner.setConnected(true);
    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect.poll(() => tailFetchStarted).toBe(true);
    return { owner, release: releaseTailFetch };
  }

  it("keeps the handoff through the first synchronized page and releases it when the chat is current", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    sentCreateHandoff();
    const { owner, release } = await ownerWithHeldCatchUp();

    owner.applyTimelineResponse(syncedTailPage());
    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toMatchObject({ status: "synced" });
    expect(createHandoff()).toMatchObject({ agentId: AGENT_ID, lifecycle: "sent" });

    release();
    await expect.poll(() => createHandoff()).toBeUndefined();
    owner.dispose();
  });

  it("releases the handoff when the chat's tab closes before catch-up completes", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    sentCreateHandoff();
    const { owner, release } = await ownerWithHeldCatchUp();

    owner.replaceVisibleAgentIds("test", []);
    owner.replaceOpenTabAgentIds([]);

    expect(createHandoff()).toBeUndefined();
    release();
    owner.dispose();
  });
});

function createSqliteCache() {
  const database = new DatabaseSync(":memory:");
  let beforeRead = async () => {};
  const connection: ReplicaSqliteConnection = {
    async exec(sql) {
      database.exec(sql);
    },
    async run(sql, params = []) {
      database.prepare(sql).run(...params);
    },
    async all<Row>(sql: string, params: readonly SqliteValue[] = []) {
      const rows = database.prepare(sql).all(...params) as Row[];
      if (sql.includes("FROM rows") && sql.includes("WHERE")) await beforeRead();
      return rows;
    },
    async transaction(operation) {
      database.exec("BEGIN IMMEDIATE");
      try {
        await operation(connection);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const storage = createSqliteReplicaRowStore({ open: async () => connection }, 1);
  const cache = new ReplicaCache(storage, { clearLegacyCache: async () => {} });
  return {
    cache,
    database,
    holdRead: (operation: () => Promise<void>) => {
      beforeRead = operation;
    },
  };
}

describe("SQLite baseline restoration", () => {
  it.each([false, true])(
    "keeps display-only cached history under a live event (synced=%s)",
    async (synced) => {
      useSessionStore.getState().initializeSession(SERVER_ID, null);
      const { cache, database, holdRead } = createSqliteCache();
      cache.setHosts([SERVER_ID]);
      cache.commitTimeline(SERVER_ID, AGENT_ID, {
        ...cachedTimeline(),
        items: [item("earlier", "earlier", 1), ...cachedTimeline().items],
        range: null,
      });
      await cache.flush();
      holdRead(async () => {
        if (synced) applySynced(AGENT_ID, 8);
        else
          useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
            head: [item("cached", "cached", 4), item("live", "live", 5)],
          });
      });
      const replica = createTimelineReplica({
        serverId: SERVER_ID,
        storage: cache,
        prepareAgent: async () => {},
      });
      await replica.prepare(AGENT_ID);
      const session = useSessionStore.getState().sessions[SERVER_ID];
      const timeline = selectAgentTimelineState(session, AGENT_ID);
      expect(timeline.status).toBe(synced ? "synced" : "painted");
      expect([
        ...(timeline.status === "cold" ? [] : timeline.items),
        ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
      ]).toEqual(
        synced
          ? [item(`network-${AGENT_ID}`, "network", 8)]
          : [item("earlier", "earlier", 1), item("cached", "cached", 4), item("live", "live", 5)],
      );
      expect(replica.readCursor(AGENT_ID)).toBeUndefined();
      database.close();
    },
  );

  it("starts the timeline disk read while agent preparation is pending", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { cache, database, holdRead } = createSqliteCache();
    cache.setHosts([SERVER_ID]);
    cache.commitTimeline(SERVER_ID, AGENT_ID, cachedTimeline());
    await cache.flush();
    let readStarted = false;
    let release!: () => void;
    const agentReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    holdRead(async () => {
      readStarted = true;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: cache,
      prepareAgent: () => agentReady,
    });
    const preparation = replica.prepare(AGENT_ID);
    try {
      await expect.poll(() => readStarted, { timeout: 500 }).toBe(true);
    } finally {
      release();
      await preparation;
      database.close();
    }
  });
});

describe("viewed owner canonical prompt retention", () => {
  const storage: TimelineReplicaStorage = {
    readTimeline: async () => undefined,
    commitTimeline: () => undefined,
  };
  it("retains four isolated canonical points without changing the viewed cursor, tail or pagination", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    applySynced(AGENT_ID, 100);
    const before = useSessionStore.getState().sessions[SERVER_ID]!;
    const cursor = before.agentTimelineCursor.get(AGENT_ID)!;
    const owner = createOwner(storage, () => cursor);
    const channel = {};
    for (let index = 0; index < 5; index += 1) {
      const source = item(`source-${index}`, "answer", 60 + index);
      const prompt: Extract<StreamItem, { kind: "user_message" }> = {
        ...source,
        kind: "user_message",
        text: "answer",
        id: `user-${index}`,
        timelineCursor: { epoch: "epoch-1", seq: index + 1 },
      };
      await requestPromptFixture(owner.promptContexts, {
        agentId: AGENT_ID,
        channel,
        source,
        signal: new AbortController().signal,
        fetchContext: async () => ({
          sourceKey: canonicalPromptSourceKey(source),
          sourceStart: 50 + index,
          sourceEnd: 60 + index,
          prompt,
        }),
      });
    }
    expect(owner.promptContexts.snapshot(AGENT_ID)?.ranges).toEqual(
      [2, 3, 4, 5].map((seq) => ({ startSeq: seq, endSeq: seq })),
    );
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1")).toHaveLength(4);
    expect(useSessionStore.getState().sessions[SERVER_ID]).toBe(before);
    expect(before.agentTimelineCursor.get(AGENT_ID)).toBe(cursor);
    owner.dispose();
  });

  it("keeps five mounted readers independent and releases only the retired reader's points", async () => {
    const owner = createOwner(storage, () => ({ epoch: "epoch-1", endSeq: 100 }));
    const readers = Array.from({ length: 5 }, () => ({}));
    for (const [index, channel] of readers.entries()) {
      const source = item(`source-${index}`, "answer", 60 + index);
      const prompt: Extract<StreamItem, { kind: "user_message" }> = {
        ...source,
        kind: "user_message",
        text: "answer",
        id: `user-${index}`,
        timelineCursor: { epoch: "epoch-1", seq: index + 1 },
      };
      await requestPromptFixture(owner.promptContexts, {
        agentId: AGENT_ID,
        channel,
        source,
        signal: new AbortController().signal,
        fetchContext: async () => ({
          sourceKey: canonicalPromptSourceKey(source),
          sourceStart: 50 + index,
          sourceEnd: 60 + index,
          prompt,
        }),
      });
    }
    for (const [index, channel] of readers.entries())
      expect(
        owner.promptContexts.read(AGENT_ID, "epoch-1", channel).map(({ prompt }) => prompt.id),
      ).toEqual([`user-${index}`]);
    const first = owner.promptContexts.read(AGENT_ID, "epoch-1", readers[0]);
    owner.promptContexts.cancel(readers[0]!);
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1", readers[0])).toBe(first);
    owner.promptContexts.release(readers[4]!);
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1", readers[4])).toEqual([]);
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1", readers[0])).toBe(first);
    expect(owner.promptContexts.snapshot(AGENT_ID)?.ranges).toHaveLength(4);
    for (const channel of readers) owner.promptContexts.release(channel);
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1")).toEqual([]);
    owner.dispose();
  });

  it("discards replaced-source, changed-epoch and disposed-owner completions", async () => {
    let epoch = "epoch-1";
    const owner = createOwner(storage, () => ({ epoch, endSeq: 100 }));
    const source = item("source", "answer", 50);
    const prompt: Extract<StreamItem, { kind: "user_message" }> = {
      ...source,
      kind: "user_message",
      text: "answer",
      id: "user",
      timelineCursor: { epoch, seq: 4 },
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchContext = async () => {
      await held;
      return {
        sourceKey: canonicalPromptSourceKey(source),
        sourceStart: 40,
        sourceEnd: 50,
        prompt,
      };
    };
    const channel = {};
    const first = requestPromptFixture(owner.promptContexts, {
      agentId: AGENT_ID,
      source,
      channel,
      signal: new AbortController().signal,
      fetchContext,
    });
    const rejected = expect(first).rejects.toThrow("no longer current");
    owner.promptContexts.cancel(channel);
    release();
    await rejected;
    const late = requestPromptFixture(owner.promptContexts, {
      agentId: AGENT_ID,
      source,
      channel,
      signal: new AbortController().signal,
      fetchContext,
    });
    const changed = expect(late).rejects.toThrow("no longer current");
    epoch = "epoch-2";
    owner.promptContexts.setEpoch(AGENT_ID, epoch);
    await changed;
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1")).toEqual([]);
    owner.dispose();
    await expect(
      requestPromptFixture(owner.promptContexts, {
        agentId: AGENT_ID,
        source,
        channel,
        signal: new AbortController().signal,
        fetchContext,
      }),
    ).rejects.toThrow("unavailable");
  });
});

describe("viewed owner source metadata acceptance", () => {
  type Payload = Parameters<ViewedTimelineOwner["applyTimelineResponse"]>[0];
  function page(start = 2, end = 4): Payload {
    return {
      requestId: "metadata",
      agent: null,
      agentId: AGENT_ID,
      direction: "tail",
      projection: "projected",
      epoch: "epoch-1",
      reset: true,
      window: { minSeq: 1, maxSeq: end, nextSeq: end + 1 },
      startCursor: { epoch: "epoch-1", seq: start },
      endCursor: { epoch: "epoch-1", seq: end },
      hasOlder: true,
      hasNewer: false,
      error: null,
      staleCursor: false,
      gap: false,
      entries: [
        {
          provider: "codex",
          timestamp: new Date(0).toISOString(),
          seqStart: start,
          seqEnd: end,
          sourceSeqRanges: [{ startSeq: start, endSeq: end }],
          collapsed: [],
          item: { type: "assistant_message", messageId: "same-provider-id", text: `Answer ${end}` },
        },
      ],
    };
  }
  function fixture() {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    return createOwner(
      { readTimeline: async () => undefined, commitTimeline: () => undefined },
      () => useSessionStore.getState().sessions[SERVER_ID]?.agentTimelineCursor.get(AGENT_ID),
    );
  }

  it("publishes accepted projected source descriptors with the same observable ordinary revision", () => {
    const owner = fixture();
    const observations: boolean[] = [];
    const unsubscribe = useSessionStore.subscribe((state) => {
      const timeline = selectAgentTimelineState(state.sessions[SERVER_ID], AGENT_ID);
      if (timeline.status !== "synced" || !timeline.items.length) return;
      const metadata = owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-1");
      observations.push(metadata.length === 1 && metadata[0]!.revision === timeline.items[0]);
    });
    owner.applyTimelineResponse(page());
    unsubscribe();
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every(Boolean)).toBe(true);
    const first = owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-1");
    expect(first[0]).toMatchObject({
      startSeq: 2,
      endSeq: 4,
      ranges: [{ startSeq: 2, endSeq: 4 }],
    });
    owner.applyTimelineResponse(page(7, 9));
    const next = owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-1");
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ startSeq: 7, endSeq: 9 });
    expect(next[0]!.revision).not.toBe(first[0]!.revision);
    owner.dispose();
  });

  it("admits no source metadata from discarded, erroneous or projected-before excluded entries", () => {
    const owner = fixture();
    owner.applyTimelineResponse(page(7, 9));
    const accepted = owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-1");
    owner.applyTimelineResponse({
      ...page(),
      reset: false,
      hasNewer: true,
      window: { minSeq: 1, maxSeq: 9, nextSeq: 10 },
    });
    expect(owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-1")).toBe(accepted);
    owner.applyTimelineResponse({ ...page(), error: "unavailable" });
    expect(owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-1")).toBe(accepted);
    const excluded = { ...page(1, 6).entries[0]!, seqStart: 1, seqEnd: 6 };
    owner.applyTimelineResponse({
      ...page(3, 6),
      direction: "before",
      reset: false,
      entries: [excluded],
    });
    expect(
      owner.promptContexts
        .readSourceMetadata(AGENT_ID, "epoch-1")
        .some((entry) => entry.startSeq === 1),
    ).toBe(false);
    owner.dispose();
  });

  it("checks the current root ordinary store before reusing or admitting an exact certificate", async () => {
    const owner = fixture();
    owner.applyTimelineResponse(page(500, 500));
    const timeline = selectAgentTimelineState(
      useSessionStore.getState().sessions[SERVER_ID],
      AGENT_ID,
    );
    if (timeline.status !== "synced") throw new Error("Expected accepted fixture timeline");
    const source = timeline.items[0]!;
    const prior: Extract<StreamItem, { kind: "user_message" }> = {
      kind: "user_message",
      id: "prior",
      text: "Prior",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 20 },
    };
    const newer = { ...prior, id: "newer", timelineCursor: { epoch: "epoch-1", seq: 450 } };
    const payload = {
      sourceKey: canonicalPromptSourceKey(source),
      sourceStart: 500,
      sourceEnd: 500,
      prompt: prior,
    };
    const seed = {};
    await requestPromptFixture(owner.promptContexts, {
      agentId: AGENT_ID,
      channel: seed,
      source,
      signal: new AbortController().signal,
      fetchContext: async () => payload,
    });
    const proof = owner.promptContexts.read(AGENT_ID, "epoch-1", seed)[0]!;
    function ordinary(items: StreamItem[]) {
      useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
        items,
        head: [],
        range: {
          epoch: "epoch-1",
          startSeq: 490,
          endSeq: 600,
          retainedRanges: [{ startSeq: 400, endSeq: 460, hasOlder: true }],
        },
        older: "available",
        newer: false,
        synchronized: true,
        acknowledgedClientMessageIds: [],
      });
    }
    ordinary([newer, source]);
    expect(owner.promptContexts.preview(AGENT_ID, source)).toBeUndefined();
    const channel = {};
    let calls = 0;
    await expect(
      requestPromptFixture(owner.promptContexts, {
        agentId: AGENT_ID,
        channel,
        source,
        signal: new AbortController().signal,
        knownContext: { ...proof },
        lookupAllowed: false,
        fetchContext: async () => {
          calls += 1;
          return payload;
        },
      }),
    ).rejects.toThrow("Reading context changed");
    ordinary([source]);
    expect(owner.promptContexts.isSupportedContext(AGENT_ID, proof)).toBe(false);
    expect(owner.promptContexts.preview(AGENT_ID, source)).toBeUndefined();
    expect(calls).toBe(0);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = requestPromptFixture(owner.promptContexts, {
      agentId: AGENT_ID,
      channel,
      source,
      signal: new AbortController().signal,
      retryToken: 1,
      fetchContext: async () => {
        await held;
        return payload;
      },
    });
    const rejected = expect(pending).rejects.toThrow("Reading context changed");
    ordinary([newer, source]);
    release();
    await rejected;
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1", channel)).toEqual([]);
    ordinary([source]);
    await expect(
      requestPromptFixture(owner.promptContexts, {
        agentId: AGENT_ID,
        channel,
        source,
        signal: new AbortController().signal,
        retryToken: 2,
        fetchContext: async () => ({ ...payload, prompt: newer }),
      }),
    ).resolves.toMatchObject(newer);
    expect(
      owner.promptContexts.readExactContext(AGENT_ID, source)?.prompt.timelineCursor?.seq,
    ).toBe(450);
    expect(owner.promptContexts.isSupportedContext(AGENT_ID, proof)).toBe(false);
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1", seed)).toEqual([proof]);
    owner.dispose();
  });

  it("invalidates retained certificates at accepted history boundaries even without an intervening cache read", async () => {
    const owner = fixture();
    owner.applyTimelineResponse(page(500, 500));
    function currentSource() {
      const timeline = selectAgentTimelineState(
        useSessionStore.getState().sessions[SERVER_ID],
        AGENT_ID,
      );
      if (timeline.status !== "synced") throw new Error("Expected accepted fixture timeline");
      const source = timeline.items.find((entry) => entry.kind === "assistant_message");
      if (!source) throw new Error("Expected accepted assistant");
      return source;
    }
    const source = currentSource();
    const prior: Extract<StreamItem, { kind: "user_message" }> = {
      kind: "user_message",
      id: "prior",
      text: "Prior",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 20 },
    };
    const payload = {
      sourceKey: canonicalPromptSourceKey(source),
      sourceStart: 500,
      sourceEnd: 500,
      prompt: prior,
    };
    const seed = {};
    await requestPromptFixture(owner.promptContexts, {
      agentId: AGENT_ID,
      channel: seed,
      source,
      signal: new AbortController().signal,
      fetchContext: async () => payload,
    });
    const proof = owner.promptContexts.read(AGENT_ID, "epoch-1", seed)[0]!;
    const accepted = page(500, 500);
    owner.applyTimelineResponse({
      ...accepted,
      startCursor: { epoch: "epoch-1", seq: 450 },
      entries: [
        {
          ...accepted.entries[0]!,
          seqStart: 450,
          seqEnd: 450,
          sourceSeqRanges: [{ startSeq: 450, endSeq: 450 }],
          item: { type: "user_message", text: "Newer prompt", clientMessageId: "newer" },
        },
        ...accepted.entries,
      ],
    });
    owner.applyTimelineResponse(page(500, 500));
    expect(canonicalPromptSourceKey(currentSource())).toBe(proof.sourceKey);
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1", seed)).toMatchObject([proof]);
    expect(owner.promptContexts.readExactContext(AGENT_ID, currentSource())).toBeUndefined();
    expect(owner.promptContexts.isSupportedContext(AGENT_ID, proof)).toBe(false);
    owner.dispose();
  });

  it("fences a fresh held lookup across accepted root USER appearance and eviction without a cache read", async () => {
    const owner = fixture();
    owner.applyTimelineResponse(page(500, 500));
    const timeline = selectAgentTimelineState(
      useSessionStore.getState().sessions[SERVER_ID],
      AGENT_ID,
    );
    if (timeline.status !== "synced") throw new Error("Expected accepted fixture timeline");
    const source = timeline.items[0]!;
    const prior: Extract<StreamItem, { kind: "user_message" }> = {
      kind: "user_message",
      id: "prior",
      text: "Prior",
      timestamp: new Date(0),
      timelineCursor: { epoch: "epoch-1", seq: 20 },
    };
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const channel = {};
    const payload = {
      sourceKey: canonicalPromptSourceKey(source),
      sourceStart: 500,
      sourceEnd: 500,
      prompt: prior,
    };
    const pending = requestPromptFixture(owner.promptContexts, {
      agentId: AGENT_ID,
      channel,
      source,
      signal: new AbortController().signal,
      fetchContext: async () => {
        reads += 1;
        await held;
        return payload;
      },
    });
    const rejected = expect(pending).rejects.toThrow("Reading context changed");
    const accepted = page(500, 500);
    owner.applyTimelineResponse({
      ...accepted,
      startCursor: { epoch: "epoch-1", seq: 450 },
      entries: [
        {
          ...accepted.entries[0]!,
          seqStart: 450,
          seqEnd: 450,
          sourceSeqRanges: [{ startSeq: 450, endSeq: 450 }],
          item: { type: "user_message", text: "Newer prompt", clientMessageId: "newer" },
        },
        ...accepted.entries,
      ],
    });
    owner.applyTimelineResponse(page(500, 500));
    release();
    await rejected;
    expect(owner.promptContexts.read(AGENT_ID, "epoch-1", channel)).toEqual([]);
    await expect(
      requestPromptFixture(owner.promptContexts, {
        agentId: AGENT_ID,
        channel,
        source,
        signal: new AbortController().signal,
        fetchContext: async () => {
          reads += 1;
          return payload;
        },
      }),
    ).rejects.toThrow("Reading context changed");
    expect(reads).toBe(1);
    const newer = { ...prior, id: "newer", timelineCursor: { epoch: "epoch-1", seq: 450 } };
    await expect(
      requestPromptFixture(owner.promptContexts, {
        agentId: AGENT_ID,
        channel,
        source,
        signal: new AbortController().signal,
        retryToken: 1,
        fetchContext: async () => ({ ...payload, prompt: newer }),
      }),
    ).resolves.toMatchObject(newer);
    owner.dispose();
  });

  it("evicts removed and live-replaced source revisions without extending coverage or persisting metadata", () => {
    const owner = fixture();
    owner.applyTimelineResponse(page());
    const cursor = useSessionStore
      .getState()
      .sessions[SERVER_ID]!.agentTimelineCursor.get(AGENT_ID)!;
    owner.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", messageId: "same-provider-id", text: " extended" },
      },
      epoch: "epoch-1",
      seq: 5,
      timestamp: new Date(1),
    });
    owner.flushStreamAgent(AGENT_ID);
    expect(owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-1")).toEqual([]);
    expect(cursor).toMatchObject({ startSeq: 2, endSeq: 4 });
    owner.applyTimelineResponse({
      ...page(10, 12),
      epoch: "epoch-2",
      startCursor: { epoch: "epoch-2", seq: 10 },
      endCursor: { epoch: "epoch-2", seq: 12 },
    });
    expect(owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-1")).toEqual([]);
    expect(owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-2")).toHaveLength(1);
    owner.dispose();
    expect(owner.promptContexts.readSourceMetadata(AGENT_ID, "epoch-2")).toEqual([]);
  });
});
