import { lstat, readdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ProviderHistoryPolicy,
  ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import {
  throwHistoryConflict,
  type ConfiguredClaudeHistoryStorage,
  type ProviderHistoryStorage,
} from "../../provider-history/binding.js";
import { pathsOverlap, strictlyContainsPath } from "../../provider-history/paths.js";

/** Claude's own filesystem path for a configured or observed home: resolved and NFC-normalized. */
export function claudeHistoryHome(storage: Pick<ConfiguredClaudeHistoryStorage, "home">): string {
  return path.resolve(storage.home.normalize("NFC"));
}

/** The most history entries one launch audit visits before reporting an incomplete audit. */
const MAX_AUDITED_HISTORY_ENTRIES = 10_000;
const MAX_AUDITED_HISTORY_DEPTH = 8;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Stat one path, refusing links and special files; null when it does not exist. */
async function inspectEntry(file: string): Promise<Stats | null> {
  let entry: Stats;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (entry.isSymbolicLink()) throwHistoryConflict("history-symlink");
  if (entry.isFile() && entry.nlink !== 1) throwHistoryConflict("history-hardlink");
  if (!entry.isDirectory() && !entry.isFile()) throwHistoryConflict("history-special-file");
  return entry;
}

/** Inspect a path and each of its ancestors; null when any component does not exist. */
async function ordinary(file: string): Promise<Stats | null> {
  let current = path.parse(file).root;
  let entry: Stats | null = null;
  for (const part of path.relative(current, file).split(path.sep)) {
    current = path.join(current, part);
    entry = await inspectEntry(current);
    if (!entry) return null;
  }
  return entry;
}

/**
 * The only route check repeated per prompt and per query: the process still selects the bound
 * home. Everything on disk is audited once at launch by auditClaudeHistoryRoute.
 */
export function checkClaudeHomeVariable(
  storage: ConfiguredClaudeHistoryStorage,
  env: NodeJS.ProcessEnv,
): void {
  if (env.CLAUDE_CONFIG_DIR !== storage.home) throwHistoryConflict("launch-home-conflict");
}

async function assertNotNativeRoot(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const native = [path.join(homedir(), ".claude")];
  if (env.HOME && path.isAbsolute(env.HOME)) native.push(path.join(env.HOME, ".claude"));
  for (const root of native) {
    let canonical = path.resolve(root);
    try {
      canonical = await realpath(root);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (pathsOverlap(canonical, home) || pathsOverlap(path.resolve(root), home))
      throwHistoryConflict("known-native-history-root");
  }
}

export interface ClaudeHistoryAudit {
  /** The entry bound stopped the walk, so entries past it were not checked. */
  truncated: boolean;
}

/**
 * Launch-time audit of a configured home: project namespace, native roots, the home itself, and
 * links in history and checkpoint artifacts. Throws for a refused route. Reaching the entry bound
 * is not a refusal; the result says the rest of the home was not checked.
 */
export async function auditClaudeHistoryRoute(
  storage: ConfiguredClaudeHistoryStorage,
  env: NodeJS.ProcessEnv,
): Promise<ClaudeHistoryAudit> {
  checkClaudeHomeVariable(storage, env);
  if (env.CLAUDE_CODE_PROJECT_DIR_NAME) throwHistoryConflict("unsupported-project-namespace");
  const home = claudeHistoryHome(storage);
  await assertNotNativeRoot(home, env);
  const root = await ordinary(home);
  if (!root?.isDirectory()) throwHistoryConflict("configured-root-must-already-exist");
  let visited = 0;
  // The home's ancestors were just checked, so each entry needs only its own stat.
  const walk = async (file: string, depth: number): Promise<boolean> => {
    if (visited >= MAX_AUDITED_HISTORY_ENTRIES) return false;
    visited += 1;
    if (depth > MAX_AUDITED_HISTORY_DEPTH) throwHistoryConflict("history-path-check-limit");
    const entry = await inspectEntry(file);
    if (!entry?.isDirectory()) return true;
    for (const name of await readdir(file)) {
      if (!(await walk(path.join(file, name), depth + 1))) return false;
    }
    return true;
  };
  // Only history/checkpoint artifacts. Auth, settings and integration links remain untouched.
  for (const name of [
    "projects",
    "history.jsonl",
    "file-history",
    "session-env",
    "todos",
    "tasks",
    "shell-snapshots",
  ]) {
    if (!(await walk(path.join(home, name), 0))) return { truncated: true };
  }
  return { truncated: false };
}

interface ConfiguredClaudeHistoryInput {
  policy?: ProviderHistoryPolicy;
  runtimeSettings?: ProviderRuntimeSettings;
  env: NodeJS.ProcessEnv;
  previous?: ProviderHistoryStorage;
  existingSession?: boolean;
  /** Configured extraArgs as given; any present selector key refuses the configured route. */
  extraArgs?: unknown;
}

function configuredClaudeHome(runtimeSettings: ProviderRuntimeSettings | undefined): string {
  const home = runtimeSettings?.env?.CLAUDE_CONFIG_DIR;
  if (!home || !path.isAbsolute(home) || home.startsWith("\\\\") || home.startsWith("//"))
    throwHistoryConflict("explicit-profile-home-required");
  return home;
}
function checkClaudeCommand(input: ConfiguredClaudeHistoryInput): void {
  const command = input.runtimeSettings?.command;
  if (command?.mode === "replace" || (command?.mode === "append" && command.args?.length))
    throwHistoryConflict("unresolved-command-contract");
  // Object() keeps the check total for unvalidated catalog options without a cast.
  if (input.extraArgs && Object.keys(Object(input.extraArgs)).length)
    throwHistoryConflict("unresolved-command-selectors");
}

export function resolveConfiguredClaudeHistory(
  input: ConfiguredClaudeHistoryInput,
): ConfiguredClaudeHistoryStorage | undefined {
  const prior = input.previous?.kind === "configured-home" ? input.previous : undefined;
  if (!prior && input.policy?.mode !== "configured") return undefined;
  if (prior && prior.provider !== "claude") throwHistoryConflict("bound-provider-conflict");
  if (!prior && input.existingSession) throwHistoryConflict("existing-route-unverified");
  const home = configuredClaudeHome(input.runtimeSettings);
  if (prior && prior.home !== home) throwHistoryConflict("bound-storage-changed");
  checkClaudeCommand(input);
  const selected: ConfiguredClaudeHistoryStorage = {
    kind: "configured-home",
    provider: "claude",
    home,
  };
  checkClaudeHomeVariable(selected, input.env);
  return selected;
}

/** The new transcript of an identity change must be an ordinary file inside the bound home. */
export async function checkClaudeRewindHandle(
  storage: ConfiguredClaudeHistoryStorage,
  env: NodeJS.ProcessEnv,
  file: string,
): Promise<void> {
  checkClaudeHomeVariable(storage, env);
  if (!strictlyContainsPath(path.join(claudeHistoryHome(storage), "projects"), file))
    throwHistoryConflict("rewind-transcript-outside-home");
  if (!(await ordinary(file))?.isFile()) throwHistoryConflict("rewind-transcript-missing");
}
