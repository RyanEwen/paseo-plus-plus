import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { stripCwdPrefix } from "@getpaseo/protocol/path-utils";
import { parseFileChanges } from "@getpaseo/protocol/tool-call-activity";
import { parseUnifiedDiff, type DiffLine } from "@/utils/tool-call-parsers";

// Fork-owned so the view can be removed cleanly if upstream's multi-file patch rendering
// replaces it at a later sync.

type FileChange = NonNullable<ReturnType<typeof parseFileChanges>>[number];

/** A file in a provider patch batch that the row's canonical detail does not show. */
export interface AdditionalFile {
  path: string;
  /** The path relative to the working directory. */
  displayPath: string;
  kind: FileChange["kind"];
  diff: string | undefined;
}

/** The additional files of a row, and how pressing one of them opens it. */
export interface AdditionalFilesControl {
  files: readonly AdditionalFile[];
  onOpenFile: ((path: string) => void) | undefined;
}

interface ReadableFileBatchInput {
  readable: boolean;
  agentMessage?: unknown;
  metadata?: Record<string, unknown>;
  cwd?: string;
}

interface ReadableFileBatch {
  detail: ToolCallDetail | undefined;
  additionalFiles: readonly AdditionalFile[];
}

const NO_ADDITIONAL_FILES: readonly AdditionalFile[] = [];

const UNIFIED_DIFF_MARKER = /^(?:diff --git |--- |\+\+\+ |@@)/m;

function isFileChangeDetail(detail: ToolCallDetail | undefined): detail is ToolCallDetail {
  return detail?.type === "edit" || detail?.type === "write" || detail?.type === "unknown";
}

function canonicalFilePath(detail: ToolCallDetail): string | undefined {
  return detail.type === "edit" || detail.type === "write" ? detail.filePath : undefined;
}

/**
 * Split a provider patch batch into the canonical detail and the files it leaves out. Only
 * applies with readable activity on and two or more valid files; otherwise the source detail
 * is unchanged. A canonical detail that names no file holds only raw batch data, so it is
 * dropped and every file is listed instead.
 */
export function splitReadableFileBatch(
  source: ToolCallDetail | undefined,
  input: ReadableFileBatchInput,
): ReadableFileBatch {
  const unchanged = { detail: source, additionalFiles: NO_ADDITIONAL_FILES };
  if (!input.readable || input.agentMessage || !isFileChangeDetail(source)) {
    return unchanged;
  }
  const files = parseFileChanges(input.metadata?.fileChanges);
  if (!files || files.length < 2) {
    return unchanged;
  }
  const shownPath = canonicalFilePath(source);
  return {
    detail: source.type === "unknown" ? undefined : source,
    additionalFiles: files
      .filter((file) => file.path !== shownPath)
      .map((file) => ({
        path: file.path,
        displayPath: stripCwdPrefix(file.path, input.cwd),
        kind: file.kind,
        diff: file.diff,
      })),
  };
}

/** Codex reports a whole added or deleted file as plain content rather than a diff. */
function contentDiffLines(content: string, type: "add" | "remove"): DiffLine[] {
  const prefix = type === "add" ? "+" : "-";
  return content
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => ({ type, content: `${prefix}${line}` }));
}

/** The diff rows for one additional file; empty when the provider sent no diff. */
export function additionalFileDiffLines(file: Pick<AdditionalFile, "kind" | "diff">): DiffLine[] {
  if (!file.diff) {
    return [];
  }
  if (UNIFIED_DIFF_MARKER.test(file.diff)) {
    return parseUnifiedDiff(file.diff);
  }
  if (file.kind === "add") {
    return contentDiffLines(file.diff, "add");
  }
  if (file.kind === "delete") {
    return contentDiffLines(file.diff, "remove");
  }
  return parseUnifiedDiff(file.diff);
}
