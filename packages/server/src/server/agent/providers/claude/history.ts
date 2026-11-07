import { lstatSync, readdirSync, realpathSync } from "node:fs";
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

function ordinary(file: string) {
  let current = path.parse(file).root;
  for (const part of path.relative(current, file).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throwHistoryConflict("history-symlink");
      if (stat.isFile() && stat.nlink !== 1) throwHistoryConflict("history-hardlink");
      if (!stat.isDirectory() && !stat.isFile()) throwHistoryConflict("history-special-file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  return lstatSync(file);
}

export function checkClaudeHistoryRoute(
  storage: ConfiguredClaudeHistoryStorage,
  env: NodeJS.ProcessEnv,
): void {
  if (env.CLAUDE_CONFIG_DIR !== storage.home) throwHistoryConflict("launch-home-conflict");
  if (env.CLAUDE_CODE_PROJECT_DIR_NAME) throwHistoryConflict("unsupported-project-namespace");
  const home = claudeHistoryHome(storage);
  const native = [path.join(homedir(), ".claude")];
  if (env.HOME && path.isAbsolute(env.HOME)) native.push(path.join(env.HOME, ".claude"));
  for (const root of native) {
    let canonical = path.resolve(root);
    try {
      canonical = realpathSync.native(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (pathsOverlap(canonical, home) || pathsOverlap(path.resolve(root), home))
      throwHistoryConflict("known-native-history-root");
  }
  if (!ordinary(home)?.isDirectory()) throwHistoryConflict("configured-root-must-already-exist");
  let visited = 0;
  const walk = (file: string, depth = 0): void => {
    if (++visited > 10_000 || depth > 8) throwHistoryConflict("history-path-check-limit");
    if (!ordinary(file)?.isDirectory()) return;
    for (const name of readdirSync(file)) walk(path.join(file, name), depth + 1);
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
  ])
    walk(path.join(home, name));
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
  checkClaudeHistoryRoute(selected, input.env);
  return selected;
}

export function checkClaudeRewindHandle(
  storage: ConfiguredClaudeHistoryStorage,
  env: NodeJS.ProcessEnv,
  file: string,
): void {
  checkClaudeHistoryRoute(storage, env);
  if (!strictlyContainsPath(path.join(claudeHistoryHome(storage), "projects"), file))
    throwHistoryConflict("rewind-transcript-outside-home");
  if (!ordinary(file)?.isFile()) throwHistoryConflict("rewind-transcript-missing");
}
