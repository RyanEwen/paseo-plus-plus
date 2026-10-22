import { hydrateStreamState } from "@/types/stream";
import type { StreamItem } from "@/types/stream";
type UserPrompt = Extract<StreamItem, { kind: "user_message" }>;

/** Decode canonical prompt content with the transcript renderer, preserving attachments. */
export function hydratePromptEntry(
  entry: import("./read-canonical-prompt-context").ContextEntry,
  epoch: string,
): UserPrompt {
  const item = hydrateStreamState(
    [
      {
        event: {
          type: "timeline",
          provider: entry.provider,
          item: entry.item,
          turnId: entry.turnId,
        },
        timestamp: new Date(entry.timestamp),
        timelineCursor: { epoch, seq: entry.seqEnd },
      },
    ],
    { source: "canonical" },
  ).find((candidate): candidate is UserPrompt => candidate.kind === "user_message");
  if (!item) throw new Error("Prompt content is unavailable");
  return item;
}
