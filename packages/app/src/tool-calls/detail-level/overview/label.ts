import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useReadableToolActivity } from "@/tool-calls/use-readable-tool-activity";
import type { OverviewSummary } from "./model";

/** Readable tool activity words counts as operations rather than claims of success. */
const READABLE_COUNT_KEYS = {
  "toolCallGroup.editedFiles": "toolActivity.counts.editedFiles",
  "toolCallGroup.commands": "toolActivity.counts.commands",
  "toolCallGroup.readFiles": "toolActivity.counts.readFiles",
  "toolCallGroup.searches": "toolActivity.counts.searches",
  "toolCallGroup.otherTools": "toolActivity.counts.otherTools",
} as const;

function joinSummaryParts(parts: string[], conjunction: string): string {
  if (parts.length === 0) {
    return "";
  }
  let joined = parts[0] ?? "";
  if (parts.length === 2) {
    joined = `${parts[0]} ${conjunction} ${parts[1]}`;
  } else if (parts.length > 2) {
    joined = `${parts.slice(0, -1).join(", ")}, ${conjunction} ${parts.at(-1)}`;
  }
  const firstCharacter = joined[0];
  return firstCharacter ? `${firstCharacter.toLocaleUpperCase()}${joined.slice(1)}` : joined;
}

/**
 * One sentence of what a stretch of agent work did, such as "Edited 2 files and ran 3 commands".
 * Leading parts come first, for summaries that count more than tool calls.
 */
export function useOverviewSummaryLabel(
  summary: OverviewSummary,
  leadingParts: readonly string[] = [],
): string {
  const { t } = useTranslation();
  // Counts come from the stream projection, which applies the same preference.
  const readable = useReadableToolActivity();
  return useMemo(() => {
    const parts = [...leadingParts];
    const entries = [
      [summary.editedFileCount, "toolCallGroup.editedFiles"],
      [summary.commandCount, "toolCallGroup.commands"],
      [summary.readFileCount, "toolCallGroup.readFiles"],
      [summary.searchCount, "toolCallGroup.searches"],
      [summary.otherToolCount, "toolCallGroup.otherTools"],
    ] as const;
    for (const [count, key] of entries) {
      if (count > 0) {
        const countKey = readable ? READABLE_COUNT_KEYS[key] : key;
        parts.push(t(`${countKey}.${count === 1 ? "one" : "other"}`, { count }));
      }
    }
    for (const [action, count] of Object.entries(summary.paseoActions)) {
      parts.push(
        count === 1 ? action.toLocaleLowerCase() : `${action.toLocaleLowerCase()} ×${count}`,
      );
    }
    // Reasoning stays in the details; it is not an action in a work summary.
    // Keep a label for a group containing only reasoning.
    if (parts.length === 0 && summary.thoughtCount > 0) return t("toolCallGroup.thought");
    return joinSummaryParts(parts, t("toolCallGroup.and"));
  }, [leadingParts, summary, readable, t]);
}
