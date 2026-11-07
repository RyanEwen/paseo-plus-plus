import { z } from "zod";
import type { ToolCallDetail } from "./agent-types.js";

// Provider metadata is optional and untrusted, even on persisted history.
const commandActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("read"),
    command: z.string(),
    name: z.string(),
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("listFiles"),
    command: z.string(),
    path: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("search"),
    command: z.string(),
    query: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("unknown"), command: z.string() }),
]);
const commandActionsSchema = z.array(commandActionSchema).min(1);
// Codex is the only producer; it reports additions, updates and deletions, and anything else
// arrives as "unknown" so a future kind is never claimed as a creation.
const fileChangeKindSchema = z.enum(["add", "update", "delete", "unknown"]);
const fileChangesSchema = z
  .array(
    z.object({
      path: z.string().min(1),
      kind: fileChangeKindSchema,
      diff: z.string().optional(),
    }),
  )
  .min(1);

export type ToolActivityKind =
  | "read"
  | "edit"
  | "write"
  | "create"
  | "delete"
  | "search"
  | "list"
  | "command"
  | "script"
  | "change";
export interface ToolActivity {
  kind: ToolActivityKind;
  target?: string;
}

/** What each provider-reported file change proves; only an addition counts as a creation. */
const FILE_CHANGE_ACTIVITY_KIND: Record<z.output<typeof fileChangeKindSchema>, ToolActivityKind> = {
  add: "create",
  update: "edit",
  delete: "delete",
  unknown: "change",
};

/**
 * Validate one untrusted metadata batch as a whole. Returns undefined when any entry is
 * malformed, so a partial batch never stands in for the provider's complete report.
 */
function parseBatch<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Validate the entire action batch; malformed or future actions keep the command generic. */
export function parseCommandActions(
  value: unknown,
): z.output<typeof commandActionsSchema> | undefined {
  return parseBatch(commandActionsSchema, value);
}

/** Preserve all file paths and distinguish proven additions from changes that may overwrite. */
export function parseFileChanges(value: unknown): z.output<typeof fileChangesSchema> | undefined {
  return parseBatch(fileChangesSchema, value);
}

/** Recognize only a single script/test invocation, never infer its filesystem effects. */
function commandActivity(command: string): ToolActivity {
  const invocation = command.trim();
  if (/[;&|<>`$\n\r]/.test(invocation)) return { kind: "command" };
  if (
    /^(?:npm|pnpm|yarn|bun) (?:run|test|exec)\b/.test(invocation) ||
    /^(?:node|python3?|bash|sh|tsx) [\w./-]+\.(?:js|mjs|cjs|py|sh|ts)(?:\s|$)/.test(invocation)
  ) {
    return { kind: "script", target: invocation };
  }
  return { kind: "command" };
}

/** Classify canonical details across providers without interpreting opaque shell source. */
export function describeToolActivity(input: {
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
}): ToolActivity[] {
  const { detail, metadata } = input;
  const changes = parseFileChanges(metadata?.fileChanges);
  if (changes && (detail.type === "edit" || detail.type === "write" || detail.type === "unknown")) {
    return changes.map((file) => ({
      kind: FILE_CHANGE_ACTIVITY_KIND[file.kind],
      target: file.path,
    }));
  }
  switch (detail.type) {
    case "read":
    case "edit":
    case "write":
      return [{ kind: detail.type, target: detail.filePath }];
    case "search":
      return [{ kind: "search", target: detail.query }];
    case "shell": {
      const actions = parseCommandActions(metadata?.commandActions);
      if (!actions) return [commandActivity(detail.command)];
      return actions.map((action) => {
        switch (action.type) {
          case "read":
            return { kind: "read", target: action.path };
          case "listFiles":
            return { kind: "list", target: action.path ?? undefined };
          case "search":
            return { kind: "search", target: action.query ?? action.path ?? undefined };
          case "unknown":
            return commandActivity(action.command);
        }
      });
    }
    default:
      return [];
  }
}
