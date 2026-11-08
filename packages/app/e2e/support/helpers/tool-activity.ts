import type { Locator, Page } from "@playwright/test";

/**
 * The readable tool activity scene the mock provider emits when it receives
 * TOOL_ACTIVITY_SCENE_PROMPT (packages/server/src/server/agent/providers/mock-tool-activity-scene.ts).
 * These strings are what the rows and details must show.
 */
export const TOOL_ACTIVITY_SCENE_PROMPT = "Emit the readable tool activity scene.";
export const TOOL_ACTIVITY_SCENE_SIZE = 7;
export const ACTIVITY_READ_COMMAND = "cat src/notifications.ts";
export const ACTIVITY_READ_OUTPUT = "export const notification = 'exact preserved output';";
export const ACTIVITY_OPAQUE_COMMAND = "python - <<'PY'\nprint('opaque script output')\nPY";
const ACTIVITY_CANONICAL_PATCH_DIFF = "created-file-exact-diff";
const ACTIVITY_ADDITIONAL_PATCH_DIFFS = [
  "updated-file-exact-diff",
  "deleted-file-exact-diff",
] as const;

export type ActivityLabelMode = "readable" | "classic";

/** What the scene shows in each label mode: the group summary and each row's label, in order. */
export const ACTIVITY_SCENE_LABELS: Record<
  ActivityLabelMode,
  {
    groupParts: readonly string[];
    readSummary: string;
    rows: readonly string[];
    /** Patch diffs each mode shows; classic keeps the canonical first file only. */
    shownPatchDiffs: readonly string[];
    hiddenPatchDiffs: readonly string[];
  }
> = {
  readable: {
    groupParts: ["5 file operations", "1 file read"],
    readSummary: "src/notifications.ts",
    rows: [
      "Read",
      "Failed: Edit",
      "Canceled: Write",
      "Searched",
      "Changed files",
      "Running script",
      "Failed: Run command",
    ],
    shownPatchDiffs: [ACTIVITY_CANONICAL_PATCH_DIFF, ...ACTIVITY_ADDITIONAL_PATCH_DIFFS],
    hiddenPatchDiffs: [],
  },
  classic: {
    groupParts: ["Edited 3 files", "ran 3 commands"],
    readSummary: ACTIVITY_READ_COMMAND,
    rows: ["Shell", "Edit", "Write", "Search", "Edit", "Shell", "Shell"],
    shownPatchDiffs: [ACTIVITY_CANONICAL_PATCH_DIFF],
    hiddenPatchDiffs: ACTIVITY_ADDITIONAL_PATCH_DIFFS,
  },
};

/**
 * Open a tool-call row's details: inline under the row on desktop, in the tool-call sheet on
 * compact layouts. Returns the surface that shows them and a function that closes it again.
 */
export async function openActivityDetails(
  page: Page,
  badge: Locator,
  compact: boolean,
): Promise<{ surface: Locator; close: () => Promise<void> }> {
  const toggle = badge.getByRole("button").first();
  await toggle.click();
  if (compact) {
    return {
      surface: page.getByTestId("tool-call-sheet"),
      close: () => page.getByTestId("tool-call-sheet-close").click(),
    };
  }
  return { surface: badge, close: () => toggle.click() };
}
