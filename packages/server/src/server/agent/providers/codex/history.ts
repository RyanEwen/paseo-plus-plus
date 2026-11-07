import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import type {
  ProviderHistoryPolicy,
  ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import {
  HistoryStorageConflictError,
  type HistoryConflictReason,
  type ConfiguredHistoryStorage,
  type ProviderHistoryStorage,
} from "../../provider-history/binding.js";

function conflict(reason: HistoryConflictReason): never {
  throw new HistoryStorageConflictError(reason);
}

function absolute(value: unknown, reason: HistoryConflictReason): string {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) conflict(reason);
  return path.resolve(value);
}

function selectorValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return absolute(parsed, "unresolved-command-sqlite-selector");
    } catch {
      return conflict("unresolved-command-sqlite-selector");
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'"))
    return absolute(trimmed.slice(1, -1), "unresolved-command-sqlite-selector");
  return absolute(trimmed, "unresolved-command-sqlite-selector");
}

function checkNativeArgument(arg: string): void {
  if (
    (arg.startsWith("-p") && !arg.startsWith("--")) ||
    arg === "--profile" ||
    arg.startsWith("--profile=") ||
    arg === "app-server"
  )
    conflict("unresolved-native-profile-selector");
  if (arg === "--home" || arg.startsWith("--home=") || arg.startsWith("--config-file"))
    conflict("unresolved-command-storage-selector");
}

function checkConfigOverride(override: string | undefined, sqliteHome: string): void {
  if (!override || !override.includes("=")) conflict("unresolved-command-config-selector");
  const equals = override.indexOf("=");
  const key = override.slice(0, equals).trim();
  if (key === "profile" || key.startsWith("profiles."))
    conflict("unresolved-native-profile-selector");
  if (key.includes("\\") || key.startsWith('"') || key.startsWith("'"))
    conflict("unresolved-command-config-key");
  if (key === "sqlite_home" && selectorValue(override.slice(equals + 1)) !== sqliteHome)
    conflict("command-sqlite-selector-conflict");
}

// A configured profile is an explicit startup selection, not a parser for native TOML layers.
// Arbitrary wrappers and native --profile selectors cannot establish that selection here.
function checkCommand(settings: ProviderRuntimeSettings | undefined, sqliteHome: string): void {
  const command = settings?.command;
  if (command?.mode === "replace") conflict("unresolved-command-contract");
  const args = command?.mode === "append" ? (command.args ?? []) : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    checkNativeArgument(arg);
    let override: string | undefined;
    if (arg === "-c" || arg === "--config") override = args[++i];
    else if (arg.startsWith("--config=")) override = arg.slice("--config=".length);
    else if (arg.startsWith("-c") && arg.length > 2) override = arg.slice(2);
    else continue;
    checkConfigOverride(override, sqliteHome);
  }
}

async function ordinary(file: string) {
  let current = path.parse(file).root;
  for (const part of path.relative(current, file).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) conflict("history-symlink");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
  const entry = await lstat(file);
  if (entry.isFile() && entry.nlink > 1) conflict("history-hardlink");
  if (!entry.isDirectory() && !entry.isFile()) conflict("history-special-file");
  return entry;
}

export async function checkConfiguredHistoryPaths(
  storage: ConfiguredHistoryStorage,
): Promise<void> {
  for (const root of new Set([storage.home, storage.sqliteHome])) {
    const entry = await ordinary(root);
    if (!entry?.isDirectory()) conflict("configured-root-must-already-exist");
  }
  let visited = 0;
  const walk = async (file: string, depth = 0): Promise<void> => {
    if (++visited > 10_000 || depth > 6) conflict("history-path-check-limit");
    const entry = await ordinary(file);
    if (!entry?.isDirectory()) return;
    for (const name of await readdir(file)) await walk(path.join(file, name), depth + 1);
  };
  for (const name of [
    "sessions",
    "archived_sessions",
    "thread-writer-locks",
    "history.jsonl",
    "session_index.jsonl",
  ])
    await walk(path.join(storage.home, name));
  // Only database artifacts: auth/config/plugin links elsewhere in the home are untouched.
  for (const name of await readdir(storage.sqliteHome)) {
    if (/\.sqlite(?:-(?:wal|shm))?$/.test(name)) await walk(path.join(storage.sqliteHome, name));
  }
}

export interface ConfiguredCodexHistoryInput {
  policy?: ProviderHistoryPolicy;
  runtimeSettings?: ProviderRuntimeSettings;
  profileOptions?: ProviderOptions;
  options?: ProviderOptions;
  env: Record<string, string>;
  previous?: ProviderHistoryStorage;
  existingSession?: boolean;
}

function checkLaunchSelectors(
  input: ConfiguredCodexHistoryInput,
  home: string,
  sqliteHome: string,
): void {
  if (absolute(input.env.CODEX_HOME, "launch-home-unresolved") !== home)
    conflict("launch-home-conflict");
  const envSqlite = input.env.CODEX_SQLITE_HOME?.trim();
  if (envSqlite && absolute(envSqlite, "launch-sqlite-home-unresolved") !== sqliteHome)
    conflict("environment-sqlite-selector-conflict");
  if (
    input.options?.sqlite_home !== undefined &&
    absolute(input.options.sqlite_home, "request-sqlite-home-unresolved") !== sqliteHome
  )
    conflict("request-sqlite-selector-conflict");
}

function configuredCodexBinding(
  storage: ProviderHistoryStorage | undefined,
): ConfiguredHistoryStorage | undefined {
  if (storage?.kind !== "configured-home") return undefined;
  if (storage.provider !== "codex") conflict("bound-provider-conflict");
  return storage;
}

export async function resolveConfiguredCodexHistory(
  input: ConfiguredCodexHistoryInput,
): Promise<ConfiguredHistoryStorage | undefined> {
  const prior = configuredCodexBinding(input.previous);
  if (!prior && input.policy?.mode !== "configured") return undefined;
  if (!prior && input.existingSession) conflict("existing-route-unverified");
  const home = absolute(input.runtimeSettings?.env?.CODEX_HOME, "explicit-profile-home-required");
  const sqliteHome = absolute(
    input.profileOptions?.sqlite_home ?? prior?.sqliteHome,
    "explicit-profile-sqlite-home-required",
  );
  checkLaunchSelectors(input, home, sqliteHome);
  checkCommand(input.runtimeSettings, sqliteHome);
  if (prior && (prior.home !== home || prior.sqliteHome !== sqliteHome))
    conflict("bound-storage-changed");
  const selected: ConfiguredHistoryStorage = {
    kind: "configured-home",
    provider: "codex",
    home,
    sqliteHome,
  };
  // Native default roots are known without inspecting account/config files.
  const nativeRoots = new Set([path.join(homedir(), ".codex")]);
  if (input.env.HOME && path.isAbsolute(input.env.HOME))
    nativeRoots.add(path.join(input.env.HOME, ".codex"));
  if ([...nativeRoots].some((root) => rootsOverlap(root, home) || rootsOverlap(root, sqliteHome)))
    conflict("known-native-history-root");
  await checkConfiguredHistoryPaths(selected);
  return selected;
}

export function configuredHistoryStartupArgs(
  storage: ProviderHistoryStorage | undefined,
): string[] {
  return storage?.kind === "configured-home" && storage.provider === "codex"
    ? ["-c", `sqlite_home=${JSON.stringify(storage.sqliteHome)}`]
    : [];
}

function rootsOverlap(left: string, right: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };
  return contains(left, right) || contains(right, left);
}

export async function historyRootsOverlap(
  source: { home: string; sqliteHome: string },
  destination: ConfiguredHistoryStorage,
): Promise<boolean> {
  for (const left of [source.home, source.sqliteHome]) {
    for (const right of [destination.home, destination.sqliteHome]) {
      if (rootsOverlap(left, right)) return true;
      try {
        const [a, b] = await Promise.all([realpath(left), realpath(right)]);
        if (rootsOverlap(a, b)) return true;
        const [aStat, bStat] = await Promise.all([lstat(a), lstat(b)]);
        if (aStat.dev === bStat.dev && aStat.ino === bStat.ino) return true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
  return false;
}

// Only this native startup contract has storage-placement evidence in this feature.
// This trusts the selected installed CLI; a matching version is not binary attestation.
export function assertConfiguredHistoryVersion(output: string): void {
  if (output.trim() !== "codex-cli 0.166.0") conflict("configured-history-cli-version-unsupported");
}
