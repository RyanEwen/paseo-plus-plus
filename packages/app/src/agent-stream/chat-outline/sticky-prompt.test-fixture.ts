import { vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import { createActivePromptPublisher } from "./model";
import type { ChatOutline } from "./use-chat-outline";

/** Shared sticky prompt fixtures: canonical user rows, a chat outline and hook input. */

/** A canonical user row with a timeline cursor at `seq`. */
export function stickyUser(
  id: string,
  seq: number,
  epoch = "epoch-1",
): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: `Prompt ${seq}\n  preserve whitespace`,
    timestamp: new Date(0),
    timelineCursor: { epoch, seq },
  };
}

/** An indexed outline with the given prompt sequences and spied navigation. */
export function stickyOutline(prompts = [1, 2, 3]): ChatOutline {
  return {
    prompts: prompts.map((seq) => ({
      seq,
      timestamp: new Date(0).toISOString(),
      preview: `Prompt ${seq}`,
    })),
    activePrompt: createActivePromptPublisher(),
    jumpToPrompt: vi.fn(),
    jumpToMessage: vi.fn(),
    reportReadingPosition: vi.fn(),
    isJumping: false,
    jumpError: false,
    indexReady: true,
    indexError: false,
    retryIndex: vi.fn(),
    cancelJump: vi.fn(),
    cancelStickyJump: vi.fn(),
    reportJumpError: vi.fn(),
  };
}

/** useStickyPrompt input over `items`, indexed with older history available. */
export function stickyInput(items: StreamItem[], outline = stickyOutline()) {
  return {
    items,
    epoch: "epoch-1",
    outline,
    indexed: true,
    hasOlder: true,
    loadingOlder: false,
    progressKey: "initial",
    loadOlder: vi.fn(async () => false),
    jumpToLoaded: vi.fn(),
  };
}
