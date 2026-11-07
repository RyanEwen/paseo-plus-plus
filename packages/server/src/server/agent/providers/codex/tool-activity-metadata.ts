import { parseCommandActions, parseFileChanges } from "@getpaseo/protocol/tool-call-activity";

/**
 * Codex facts that readable tool activity uses, carried as optional tool-call metadata. The raw
 * input and output stay exactly as Codex reported them; these batches only add structure the
 * shell command or patch text cannot prove on its own.
 */
type ToolActivityMetadata = { metadata: Record<string, unknown> } | Record<string, never>;

/** One file entry from a Codex file-change item, after path normalization. */
interface CodexFileChange {
  path: string;
  kind?: string;
  diff?: string;
}

const NO_METADATA: Record<string, never> = {};

/** Codex file-change kinds the activity model can state as proven; others stay "unknown". */
const PROVEN_FILE_CHANGE_KINDS: ReadonlySet<string> = new Set(["add", "update", "delete"]);

/**
 * Metadata for a command execution's structured actions, ready to spread into the envelope.
 * Returns no metadata when Codex sent no actions or any action is malformed.
 */
export function commandActivityMetadata(commandActions: unknown): ToolActivityMetadata {
  const actions = parseCommandActions(commandActions);
  return actions ? { metadata: { commandActions: actions } } : NO_METADATA;
}

/**
 * Metadata listing every file of a patch, ready to spread into the envelope. The batch is
 * validated by the protocol schema that readers apply, so it is emitted only when they accept it.
 */
export function fileChangeActivityMetadata(
  files: readonly CodexFileChange[],
): ToolActivityMetadata {
  const fileChanges = parseFileChanges(
    files.map((file) => ({
      path: file.path,
      diff: file.diff,
      kind: file.kind !== undefined && PROVEN_FILE_CHANGE_KINDS.has(file.kind) ? file.kind : "unknown",
    })),
  );
  return fileChanges ? { metadata: { fileChanges } } : NO_METADATA;
}
