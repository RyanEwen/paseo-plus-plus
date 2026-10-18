import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ContextPageReader } from "@/timeline/read-canonical-prompt-context";
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
    if (
      page.agentId !== agentId ||
      page.direction !== "before" ||
      page.projection !== request.projection
    )
      throw new Error("Reading context has a different journal identity");
    return page;
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
