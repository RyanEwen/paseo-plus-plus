import { expect, test, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { fetchViewedTimelinePage } from "./fetch-viewed-timeline-page";

type TimelinePage = Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;

test.each([
  ["the older page settles first", ["older", "tail"]],
  ["the tail page settles first", ["tail", "older"]],
] as const)(
  "cancelled navigation never applies its older window when %s",
  async (_label, order) => {
    let releaseOlder!: (page: TimelinePage) => void;
    let releaseTail!: (page: TimelinePage) => void;
    const older = new Promise<TimelinePage>((resolve) => {
      releaseOlder = resolve;
    });
    const tail = new Promise<TimelinePage>((resolve) => {
      releaseTail = resolve;
    });
    const owner = { flushStreamAgent: vi.fn(), applyTimelineResponse: vi.fn() };
    const controller = new AbortController();
    const olderPage = { hasNewer: true } as TimelinePage;
    const tailPage = { hasNewer: false } as TimelinePage;
    const cancelled = fetchViewedTimelinePage({
      agentId: "agent",
      fetchPage: () => older,
      getOwner: () => owner,
      signal: controller.signal,
    });
    controller.abort();
    const latest = fetchViewedTimelinePage({
      agentId: "agent",
      fetchPage: () => tail,
      getOwner: () => owner,
    });
    const release = {
      older: async () => {
        releaseOlder(olderPage);
        await cancelled;
      },
      tail: async () => {
        releaseTail(tailPage);
        await latest;
      },
    };
    for (const page of order) await release[page]();
    expect(owner.applyTimelineResponse.mock.calls).toEqual([[tailPage]]);
    expect(owner.flushStreamAgent).toHaveBeenCalledTimes(1);
  },
);

test("cancelling one shared read preserves unrelated acceptance and owner identity", async () => {
  let release!: (page: TimelinePage) => void;
  const shared = new Promise<TimelinePage>((resolve) => {
    release = resolve;
  });
  const original = { flushStreamAgent: vi.fn(), applyTimelineResponse: vi.fn() };
  const replacement = { flushStreamAgent: vi.fn(), applyTimelineResponse: vi.fn() };
  const controller = new AbortController();
  let current = original;
  const cancelled = fetchViewedTimelinePage({
    agentId: "agent",
    fetchPage: () => shared,
    getOwner: () => original,
    signal: controller.signal,
  });
  const unrelated = fetchViewedTimelinePage({
    agentId: "agent",
    fetchPage: () => shared,
    getOwner: () => original,
  });
  const replaced = fetchViewedTimelinePage({
    agentId: "agent",
    fetchPage: () => shared,
    getOwner: () => current,
  });
  controller.abort();
  current = replacement;
  release({ hasNewer: false } as TimelinePage);
  await Promise.all([cancelled, unrelated, replaced]);
  expect(original.applyTimelineResponse).toHaveBeenCalledTimes(1);
  expect(replacement.applyTimelineResponse).not.toHaveBeenCalled();
});

test("pre-cancelled acceptance makes no request", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchPage = vi.fn();
  await expect(
    fetchViewedTimelinePage({
      agentId: "agent",
      fetchPage,
      getOwner: () => null,
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled");
  expect(fetchPage).not.toHaveBeenCalled();
});
