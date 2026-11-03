import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ContextPageReader,
  ContextPromptIndexReader,
} from "@/timeline/read-canonical-prompt-context";
export {
  fetchReadingPromptContext,
  fetchCanonicalPromptContext,
  contextSourceKey,
  validateContextRange,
  matchesContextSource,
} from "@/timeline/read-canonical-prompt-context";
export type {
  ContextPage,
  ContextPageReader,
  ContextEntry,
} from "@/timeline/read-canonical-prompt-context";

/** Use the actual normal-agent journal without a runtime/store window application. */
export function normalContextPageReader(client: DaemonClient, agentId: string): ContextPageReader {
  return async (request) => {
    const page = await client.fetchAgentTimeline(agentId, {
      direction: "before",
      cursor: { epoch: request.epoch, seq: request.cursor },
      limit: request.limit,
      projection: request.projection,
    });
    // COMPAT(canonicalContextProjection): added in v0.12.0-beta.3, remove after 2027-02-02
    // once supported daemons all return projected context pages. Published v0.2.5 honors canonical.
    const matchesProjection =
      page.projection === request.projection ||
      (request.projection === "canonical" && page.projection === "projected");
    if (page.agentId !== agentId || page.direction !== "before" || !matchesProjection)
      throw new Error("Reading context has a different journal identity");
    return page;
  };
}

/** Acquire a fresh root USER index without applying a timeline window or sharing outline state. */
export function normalContextPromptIndexReader(
  client: DaemonClient,
  agentId: string,
): ContextPromptIndexReader {
  return async (_request, signal) => {
    if (signal.aborted) throw new Error("Reading context was cancelled");
    const index = await client.listAgentTimelinePrompts(agentId);
    if (signal.aborted) throw new Error("Reading context was cancelled");
    return index;
  };
}

/** Read a child journal through its exact owner. No response is applied to provider state. */
export function childContextPageReader(
  client: DaemonClient,
  parentAgentId: string,
  subagentId: string,
): ContextPageReader {
  return async (request) => {
    const page = await client.fetchProviderSubagentTimeline(parentAgentId, subagentId, {
      direction: "before",
      cursor: { epoch: request.epoch, seq: request.cursor },
      limit: request.limit,
    });
    if (
      page.parentAgentId !== parentAgentId ||
      page.subagentId !== subagentId ||
      page.direction !== "before" ||
      !page.provider
    )
      throw new Error("Reading context has a different child identity");
    return {
      ...page,
      entries: page.rows.map((row) => {
        if (row.seqStart === undefined || row.seqEnd === undefined || !row.sourceSeqRanges)
          throw new Error("Child context has no canonical source ranges");
        return {
          item: row.item,
          timestamp: row.timestamp,
          provider: page.provider!,
          seqStart: row.seqStart,
          seqEnd: row.seqEnd,
          sourceSeqRanges: row.sourceSeqRanges,
          collapsed: [],
        };
      }),
    };
  };
}
