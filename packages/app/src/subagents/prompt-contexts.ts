import { createCanonicalPromptContexts } from "@/timeline/canonical-prompt-context";
import { canonicalCoverageForCursor } from "@/timeline/canonical-reading-source";
import { EMPTY_SOURCE_METADATA } from "@/timeline/canonical-source-metadata";
import { providerSubagentKey, useProviderSubagentStore } from "./provider-store";

export interface ProviderPromptContextScope {
  serverId: string;
  parentAgentId: string;
  subagentId: string;
  agentId: string;
  epoch: string | null;
}

/** Read the compound-keyed ordinary store at admission, not a captured pane
 * render. A held result must see later child USERs before becoming a certificate. */
export function createProviderSubagentPromptContexts(scope: ProviderPromptContextScope) {
  const key = providerSubagentKey(scope.serverId, scope.parentAgentId, scope.subagentId);
  const current = () => useProviderSubagentStore.getState().timelines.get(key);
  return createCanonicalPromptContexts(
    (agentId, epoch) =>
      agentId === scope.agentId && epoch === scope.epoch && current()?.epoch === epoch,
    () => {
      const timeline = current();
      return {
        items: [...(timeline?.tail ?? []), ...(timeline?.head ?? [])],
        metadata: timeline?.sourceMetadata ?? EMPTY_SOURCE_METADATA,
        coverage: canonicalCoverageForCursor(timeline?.cursor),
      };
    },
    (observe) =>
      useProviderSubagentStore.subscribe((state, previous) => {
        const timeline = state.timelines.get(key);
        if (timeline === previous.timelines.get(key)) return;
        observe({
          agentId: scope.agentId,
          epoch: timeline?.epoch ?? null,
          items: [...(timeline?.tail ?? []), ...(timeline?.head ?? [])],
        });
      }),
  );
}
