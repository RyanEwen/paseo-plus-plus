import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { hydratePromptEntry } from "@/timeline/hydrate-prompt-entry";
export { hydratePromptEntry } from "@/timeline/hydrate-prompt-entry";
import type { UserPrompt } from "./sticky-prompt-model";

/** Fetch one indexed prompt without applying a viewport window; decode it with the
 * same canonical renderer input as the transcript, including attachment metadata.
 */
export async function fetchPromptContent(
  client: DaemonClient,
  agentId: string,
  epoch: string,
  seq: number,
): Promise<UserPrompt> {
  const page = await client.fetchAgentTimeline(agentId, {
    direction: "before",
    cursor: { epoch, seq: seq + 1 },
    limit: 1,
    projection: "projected",
  });
  if (page.error || page.epoch !== epoch || page.reset || page.staleCursor)
    throw new Error("Prompt content is unavailable");
  const entry = page.entries.find(
    (candidate) => candidate.seqEnd === seq && candidate.item.type === "user_message",
  );
  if (!entry) throw new Error("Prompt content is unavailable");
  return hydratePromptEntry(entry, epoch);
}
