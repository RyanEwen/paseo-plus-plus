import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseStoredAgentRecord, type StoredAgentRecord } from "../../agent-storage.js";
import {
  type ArtifactInventory,
  ClaudeHeader,
  CodexHeader,
  type HistoryPreviewInput,
  type Inventory,
  MAX_DATABASE_BYTES,
  MAX_FILES,
  MAX_HEADER_BYTES,
  MAX_RECORD_BYTES,
  type SessionFile,
} from "./types.js";

export function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function hash(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

// Never traverse a symlink, including one above an otherwise ordinary file.
export async function regularPath(file: string, inventory: Inventory): Promise<boolean> {
  const absolute = path.resolve(file);
  const relative = path.relative(path.parse(absolute).root, absolute);
  let current = path.parse(absolute).root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        inventory.issues.push({ code: "symlink-not-followed", path: current });
        return false;
      }
    } catch (error) {
      if (!missing(error)) throw error;
      return false;
    }
  }
  return true;
}

async function files(root: string, inventory: Inventory, depth = 0): Promise<string[]> {
  if (!(await regularPath(root, inventory))) return [];
  if (depth > 6) {
    inventory.issues.push({ code: "scan-depth-limit", path: root });
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    inventory.visited++;
    if (inventory.visited > MAX_FILES) {
      inventory.issues.push({ code: "scan-entry-limit", path: root });
      break;
    }
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) inventory.issues.push({ code: "symlink-not-followed", path: file });
    else if (entry.isDirectory()) found.push(...(await files(file, inventory, depth + 1)));
    else if (entry.isFile()) found.push(file);
  }
  return found;
}

export async function readRecords(
  home: string,
  inventory: Inventory,
): Promise<StoredAgentRecord[]> {
  const records: StoredAgentRecord[] = [];
  const paths = await files(path.join(home, "agents"), inventory);
  for (const file of paths.filter((entry) => entry.endsWith(".json"))) {
    if ((await lstat(file)).size > MAX_RECORD_BYTES) {
      inventory.issues.push({ code: "agent-record-size-limit", path: file });
      continue;
    }
    try {
      records.push(parseStoredAgentRecord(JSON.parse(await readFile(file, "utf8"))));
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      inventory.issues.push({ code: "invalid-agent-record", path: file });
    }
  }
  return records;
}

async function header(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
  } finally {
    await handle.close();
  }
}

interface SessionMetadataInput {
  family: HistoryPreviewInput["family"];
  file: string;
  raw: unknown;
  inventory: Inventory;
}
interface SessionMetadata {
  id: string;
  parents: string[];
}

function sessionMetadata(input: SessionMetadataInput): SessionMetadata | null {
  const { family, file, raw, inventory } = input;
  if (family === "codex") {
    const parsed = CodexHeader.parse(raw).payload;
    const parents = [parsed.parent_thread_id, parsed.forked_from_id].filter(
      (id): id is string => typeof id === "string",
    );
    return { id: parsed.id, parents };
  }
  const id = ClaudeHeader.parse(raw).sessionId;
  // Child/workflow transcripts may carry the parent's sessionId. They are support
  // files, not another root or proof of exclusive child ownership.
  if (path.basename(file) !== `${id}.jsonl`) {
    inventory.issues.push({ code: "claude-support-file-needs-classification", path: file });
    return null;
  }
  return { id, parents: [] };
}

async function sessionFile(input: Omit<SessionMetadataInput, "raw">): Promise<SessionFile | null> {
  const { family, file, inventory } = input;
  try {
    const before = await lstat(file);
    if (before.size > MAX_DATABASE_BYTES) {
      inventory.issues.push({ code: "session-size-limit", path: file });
      return null;
    }
    const raw: unknown = JSON.parse(await header(file));
    const metadata = sessionMetadata({ family, file, raw, inventory });
    if (!metadata) return null;
    const sha256 = await hash(file);
    const after = await lstat(file);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      inventory.issues.push({ code: "changed-during-preview", path: file });
    }
    return { ...metadata, source: file, bytes: before.size, sha256 };
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
    inventory.issues.push({ code: "unrecognized-session-header", path: file });
    return null;
  }
}

export async function readSessions(
  input: HistoryPreviewInput,
  inventory: Inventory,
): Promise<SessionFile[]> {
  const roots = input.family === "codex" ? ["sessions", "archived_sessions"] : ["projects"];
  const sessions: SessionFile[] = [];
  for (const root of roots) {
    const paths = await files(path.join(input.providerHome, root), inventory);
    for (const file of paths.filter((entry) => entry.endsWith(".jsonl"))) {
      const parsed = await sessionFile({ family: input.family, file, inventory });
      if (parsed) sessions.push(parsed);
    }
  }
  return sessions;
}

export async function artifacts(
  input: HistoryPreviewInput,
  inventory: Inventory,
): Promise<ArtifactInventory[]> {
  const paths = [
    path.join(input.providerHome, "history.jsonl"),
    path.join(input.providerHome, "session_index.jsonl"),
  ];
  if (input.family === "codex") {
    const sqlite = input.sqliteHome ?? input.providerHome;
    paths.push(
      path.join(sqlite, "thread_history_1.sqlite"),
      path.join(sqlite, "thread_history_1.sqlite-wal"),
    );
  }
  const found: ArtifactInventory[] = [];
  for (const source of paths) {
    if (!(await regularPath(source, inventory))) continue;
    const before = await lstat(source);
    if (!before.isFile() || before.size > MAX_DATABASE_BYTES) {
      inventory.issues.push({ code: "artifact-size-or-type-limit", path: source });
      continue;
    }
    const sha256 = await hash(source);
    const after = await lstat(source);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      inventory.issues.push({ code: "changed-during-preview", path: source });
    }
    found.push({ source, bytes: before.size, sha256 });
  }
  return found;
}
