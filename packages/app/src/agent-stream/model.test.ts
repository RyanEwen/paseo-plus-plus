import { createStreamPresentation, getStreamItemMessageId } from "./presentation";
import {
  mergeRetainedPrompts,
  retainedCanonicalPositions,
  type CanonicalPromptContext,
} from "@/timeline/canonical-prompt-context";
import { nativeChronologicalRows } from "./native-actual-row-model";
import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { projectPluginTimelineItems } from "@/plugins/timeline/projection";
import { findMountedWindowStart } from "./history-window";
import { buildAgentStreamRenderModel } from "./model";

function createTimestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, seed: number): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

function assistantMessage(id: string, seed: number): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

describe("buildAgentStreamRenderModel", () => {
  it("projects a bounded recent turn-aligned history window on every platform", () => {
    const tail = [
      userMessage("u1", 1),
      assistantMessage("a1", 2),
      userMessage("u2", 3),
      assistantMessage("a2", 4),
      userMessage("u3", 5),
      assistantMessage("a3", 6),
    ];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "native",
      isMobileBreakpoint: false,
      historyStart: 2,
    });

    expect(model.history.map((item) => item.id)).toEqual(["u2", "a2", "u3", "a3"]);
    expect(model.segments.historyVirtualized).toHaveLength(0);
  });

  it("derives timing only for the rendered history window", () => {
    const tail = [
      userMessage("hidden-u", 1),
      assistantMessage("hidden-a", 2),
      userMessage("visible-u", 3),
      assistantMessage("visible-a", 4),
    ];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "web",
      isMobileBreakpoint: false,
      historyStart: 2,
    });

    expect(model.turnTiming.byAssistantId.has("hidden-a")).toBe(false);
    expect(model.turnTiming.byAssistantId.get("visible-a")).toEqual({
      completedAt: tail[3]?.timestamp,
      durationMs: 1000,
    });
  });

  it("keeps the mounted boundary stable when a transformer filters an earlier item", () => {
    const tail = [
      userMessage("filtered", 1),
      assistantMessage("hidden", 2),
      userMessage("visible-u", 3),
      assistantMessage("visible-a", 4),
    ];

    const projectedTail = projectPluginTimelineItems(tail, ({ sourceId }) =>
      sourceId === "filtered" ? [] : undefined,
    );
    const historyStart = findMountedWindowStart({ items: projectedTail, minMountedCount: 2 });
    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: projectedTail,
      head: [],
      platform: "native",
      isMobileBreakpoint: false,
      historyStart,
    });

    expect(model.history.map((item) => item.id)).toEqual(["visible-u", "visible-a"]);
  });

  it("keeps head separate from committed history on desktop web", () => {
    const tail: StreamItem[] = [];
    for (let index = 0; index < 60; index += 1) {
      const seed = index * 2;
      tail.push(userMessage(`u${index}`, seed + 1));
      tail.push(assistantMessage(`a${index}`, seed + 2));
    }
    const head = [assistantMessage("live-a", 121)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail.at(-2)?.timestamp ?? null,
      tail,
      head,
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.segments.historyVirtualized.length).toBeGreaterThan(0);
    expect(model.segments.historyMounted.length).toBeGreaterThan(0);
    expect(model.segments.liveHead.map((item) => item.id)).toEqual(["live-a"]);
    expect(model.history).not.toContain(head[0]);
  });

  it("keeps the full committed tail mounted on mobile web", () => {
    const tail = [userMessage("u1", 1), assistantMessage("a1", 2)];
    const head = [assistantMessage("live-a", 3)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head,
      platform: "web",
      isMobileBreakpoint: true,
    });

    expect(model.segments.historyVirtualized).toHaveLength(0);
    expect(model.segments.historyMounted).toBe(tail);
    expect(model.segments.liveHead).toBe(head);
  });

  it("reuses ordered committed history when only the live head changes", () => {
    const tail = [userMessage("u1", 1), assistantMessage("a1", 2)];
    const firstHead = [assistantMessage("live-a", 3)];
    const secondHead = [assistantMessage("live-b", 4)];

    const first = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head: firstHead,
      platform: "native",
      isMobileBreakpoint: false,
    });
    const second = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head: secondHead,
      platform: "native",
      isMobileBreakpoint: false,
    });

    expect(first.history).toBe(second.history);
    expect(first.segments.historyMounted).toBe(second.segments.historyMounted);
    expect(second.segments.liveHead.map((item) => item.id)).toEqual(["live-b"]);
  });

  it("derives running turn timing across committed history and live head", () => {
    const tail = [userMessage("u1", 1)];
    const head = [assistantMessage("live-a", 4)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: tail[0]?.timestamp ?? null,
      tail,
      head,
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.turnTiming.runningStartedAt).toBe(tail[0]?.timestamp);
    expect(model.turnTiming.byAssistantId.has("live-a")).toBe(false);
  });

  it("maps completed turn timing to assistant ids across committed history and live head", () => {
    const tail = [userMessage("u1", 1)];
    const head = [assistantMessage("live-a", 4)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head,
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.turnTiming.runningStartedAt).toBe(null);
    expect(model.turnTiming.byAssistantId.get("live-a")).toEqual({
      completedAt: head[0]?.timestamp,
      durationMs: 3000,
    });
  });

  it("derives the same timing for chronological native rendering", () => {
    const tail = [userMessage("u1", 1), assistantMessage("a1", 4)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "native",
      isMobileBreakpoint: false,
    });

    expect(model.segments.historyMounted.map((item) => item.id)).toEqual(["u1", "a1"]);
    expect(model.turnTiming.byAssistantId.get("a1")).toEqual({
      completedAt: tail[1]?.timestamp,
      durationMs: 3000,
    });
  });

  it("does not create completed timing for adjacent user messages", () => {
    const tail = [userMessage("u1", 1), userMessage("u2", 4)];

    const model = buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head: [],
      platform: "web",
      isMobileBreakpoint: false,
    });

    expect(model.turnTiming.byAssistantId.size).toBe(0);
  });

  it.each(["web", "native"] as const)(
    "reuses rendered history and timing across live-head updates inside a history window on %s",
    (platform) => {
      const at = (seed: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seed));
      const tail: StreamItem[] = [];
      for (let index = 0; index < 40; index += 1) {
        tail.push(
          { ...userMessage(`u${index}`, 0), timestamp: at(index * 2) },
          { ...assistantMessage(`a${index}`, 0), timestamp: at(index * 2 + 1) },
        );
      }
      const live = (text: string): StreamItem => ({
        kind: "assistant_message",
        id: "live",
        text,
        timestamp: at(81),
      });
      const build = (head: StreamItem[]) =>
        buildAgentStreamRenderModel({
          isTurnActive: true,
          activeTurnStartedAt: tail.at(-2)?.timestamp ?? null,
          tail,
          head,
          platform,
          isMobileBreakpoint: false,
          historyStart: 60,
        });

      const first = build([live("live")]);
      const second = build([live("live grows")]);

      expect(second.history).toBe(first.history);
      expect(second.segments.historyMounted).toBe(first.segments.historyMounted);
      expect(second.turnTiming.byAssistantId).toBe(first.turnTiming.byAssistantId);
      expect(first.history).toHaveLength(20);
      expect(first.turnTiming.byAssistantId.has("a29")).toBe(false);
      expect(first.turnTiming.byAssistantId.get("a38")).toEqual({
        completedAt: tail[77]?.timestamp,
        durationMs: 1000,
      });
    },
  );
});

describe("actual native canonical row collection", () => {
  it("keeps one canonical prompt key while live and committed lanes overlap and hand back", () => {
    const user = userMessage("prompt", 1);
    const response = assistantMessage("response", 2);
    const live = nativeChronologicalRows({
      historyVirtualized: [],
      historyMounted: [],
      liveHead: [user, response],
    });
    const overlap = nativeChronologicalRows({
      historyVirtualized: [],
      historyMounted: [user],
      liveHead: [user, response],
    });
    const committed = nativeChronologicalRows({
      historyVirtualized: [],
      historyMounted: [user, response],
      liveHead: [],
    });
    expect(live.map((row) => row.id)).toEqual(["prompt", "response"]);
    expect(overlap).toEqual(live);
    expect(committed).toEqual(live);
    expect(overlap[0]).toBe(user);
    expect(committed[0]).toBe(user);
  });
  it("prepends older history without changing the retained user row's key or revision", () => {
    const old = userMessage("old", 1);
    const retained = userMessage("retained", 3);
    const before = nativeChronologicalRows({
      historyVirtualized: [],
      historyMounted: [retained],
      liveHead: [],
    });
    const after = nativeChronologicalRows({
      historyVirtualized: [old],
      historyMounted: [retained],
      liveHead: [],
    });
    expect(after.map((row) => row.id)).toEqual(["old", "retained"]);
    expect(after[1]).toBe(before[0]);
  });
});

describe("canonical predecessor presentation membership", () => {
  const present = (
    tail: StreamItem[],
    transform?: import("@/plugins/timeline/model").TimelineItemTransform,
  ) =>
    createStreamPresentation()({
      tail,
      head: [],
      transform,
      level: "overview",
      isTurnActive: false,
    });
  const projectedModel = (
    tail: StreamItem[],
    contexts: readonly CanonicalPromptContext[],
    historyStart: number,
    transform?: import("@/plugins/timeline/model").TimelineItemTransform,
  ) => {
    const canonical = mergeRetainedPrompts(tail, contexts);
    const presentation = present(canonical, transform);
    return buildAgentStreamRenderModel({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: presentation.tail,
      head: [],
      platform: "web",
      isMobileBreakpoint: false,
      historyStart,
      retainedPositions: retainedCanonicalPositions(canonical, contexts),
    });
  };
  const prompt = { ...userMessage("u", 1), timelineCursor: { epoch: "epoch", seq: 1 } };
  const context: CanonicalPromptContext = {
    sourceKey: "source",
    sourceStart: 40,
    sourceEnd: 50,
    prompt,
  };
  const assistant = { ...assistantMessage("a", 2), timelineCursor: { epoch: "epoch", seq: 50 } };

  it("retains a presented canonical point through the local slice without changing the ordinary tail", () => {
    const tail = [assistantMessage("hidden", 0), assistant];
    const model = projectedModel(tail, [context], 2);
    expect(model.history.map(getStreamItemMessageId)).toEqual([prompt.id, assistant.id]);
    expect(model.history[0]).toBe(prompt);
    expect(tail).toEqual([assistantMessage("hidden", 0), assistant]);
  });

  it("uses the complete ordinary revision even when it precedes historyStart", () => {
    const current = { ...prompt, text: "authoritative revision" };
    const tail = [current, assistantMessage("hidden", 0), assistant];
    const model = projectedModel(tail, [context], 2);
    expect(model.history.map(getStreamItemMessageId)).toEqual([current.id, assistant.id]);
    expect(model.history[0]).toBe(current);
    expect(mergeRetainedPrompts(tail, [context])).toBe(tail);
  });

  it("normalizes retained spoken input through the same presentation pipeline", () => {
    const spoken = {
      ...prompt,
      text: "<spoken-input>Actual spoken words</spoken-input><instruction>This message was spoken by the user.</instruction>",
    };
    const model = projectedModel([assistant], [{ ...context, prompt: spoken }], 1);
    expect(model.history[0]).toEqual({ ...spoken, text: "Actual spoken words" });
    expect(model.history).toHaveLength(2);
    expect(spoken.text).toContain("<spoken-input>");
  });

  it("respects a plugin-hidden retained prompt instead of reintroducing raw content after projection", () => {
    const model = projectedModel([assistant], [context], 0, ({ item }) =>
      item.type === "user_message" ? [] : undefined,
    );
    expect(model.history.map((item) => item.id)).not.toContain(prompt.id);
    expect(model.history.every((item) => item.kind !== "user_message")).toBe(true);
  });

  it("uses the newest retained revision and never duplicates an ordinary live-head prompt", () => {
    const updated = { ...prompt, text: "new complete content" };
    const next = { ...context, sourceKey: "second", prompt: updated };
    const canonical = mergeRetainedPrompts([], [context, next]);
    expect(canonical).toEqual([updated]);
    const tail = mergeRetainedPrompts([], [context], [updated]);
    const model = buildAgentStreamRenderModel({
      isTurnActive: true,
      activeTurnStartedAt: null,
      tail,
      head: [updated],
      platform: "web",
      isMobileBreakpoint: false,
    });
    expect(model.history).toEqual([]);
    expect(model.segments.liveHead).toEqual([updated]);
  });
});
