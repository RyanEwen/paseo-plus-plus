import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  ProviderHistoryPolicy,
  ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import {
  HistoryStorageConflictError,
  type ConfiguredClaudeHistoryStorage,
  type ProviderHistoryStorage,
} from "../../provider-history/binding.js";

function conflict(reason: string): never {
  throw new HistoryStorageConflictError(reason);
}

export function claudeHistoryHome(storage: ConfiguredClaudeHistoryStorage): string {
  return path.resolve(storage.home.normalize("NFC"));
}

function overlaps(a: string, b: string): boolean {
  const contains = (left: string, right: string) => {
    const rel = path.relative(left, right);
    return (
      rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    );
  };
  return contains(a, b) || contains(b, a);
}

function ordinary(file: string) {
  let current = path.parse(file).root;
  for (const part of path.relative(current, file).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) conflict("history-symlink");
      if (stat.isFile() && stat.nlink !== 1) conflict("history-hardlink");
      if (!stat.isDirectory() && !stat.isFile()) conflict("history-special-file");
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
  if (env.CLAUDE_CONFIG_DIR !== storage.home) conflict("launch-home-conflict");
  if (env.CLAUDE_CODE_PROJECT_DIR_NAME) conflict("unsupported-project-namespace");
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
    if (overlaps(canonical, home) || overlaps(path.resolve(root), home))
      conflict("known-native-history-root");
  }
  if (!ordinary(home)?.isDirectory()) conflict("configured-root-must-already-exist");
  let visited = 0;
  const walk = (file: string, depth = 0): void => {
    if (++visited > 10_000 || depth > 8) conflict("history-path-check-limit");
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
  extraArgs?: Record<string, string | null>;
}

function configuredClaudeHome(runtimeSettings: ProviderRuntimeSettings | undefined): string {
  const home = runtimeSettings?.env?.CLAUDE_CONFIG_DIR;
  if (!home || !path.isAbsolute(home) || home.startsWith("\\\\") || home.startsWith("//"))
    conflict("explicit-profile-home-required");
  return home;
}
function checkClaudeCommand(input: ConfiguredClaudeHistoryInput): void {
  const command = input.runtimeSettings?.command;
  if (command?.mode === "replace" || (command?.mode === "append" && command.args?.length))
    conflict("unresolved-command-contract");
  if (input.extraArgs && Object.keys(input.extraArgs).length)
    conflict("unresolved-command-selectors");
}

export function resolveConfiguredClaudeHistory(
  input: ConfiguredClaudeHistoryInput,
): ConfiguredClaudeHistoryStorage | undefined {
  const prior = input.previous?.kind === "configured-home" ? input.previous : undefined;
  if (!prior && input.policy?.mode !== "configured") return undefined;
  if (prior && prior.provider !== "claude") conflict("bound-provider-conflict");
  if (!prior && input.existingSession) conflict("existing-route-unverified");
  const home = configuredClaudeHome(input.runtimeSettings);
  if (prior && prior.home !== home) conflict("bound-storage-changed");
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
  const relative = path.relative(path.join(claudeHistoryHome(storage), "projects"), file);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    conflict("rewind-transcript-outside-home");
  if (!ordinary(file)?.isFile()) conflict("rewind-transcript-missing");
}
