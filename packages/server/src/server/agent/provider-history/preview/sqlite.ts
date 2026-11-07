import { copyFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { hash, missing, regularPath } from "./scan.js";
import {
  type DatabaseInventory,
  Edge,
  type Inventory,
  type InventoryDatabase,
  MAX_DATABASE_BYTES,
  MAX_FILES,
  type SpawnEdge,
} from "./types.js";

interface SqliteModule {
  DatabaseSync: new (file: string, options: { readOnly: boolean }) => InventoryDatabase;
}
const SqliteModuleSchema = z.object({
  DatabaseSync: z.custom<SqliteModule["DatabaseSync"]>((value) => typeof value === "function"),
});
const Column = z.object({ name: z.string() });

interface DatabaseSnapshot {
  database: DatabaseInventory;
  edges: SpawnEdge[];
}

interface DatabaseInspection {
  schema: DatabaseInventory["schema"];
  edges: SpawnEdge[];
  issue: string | null;
}

export interface HistoryPreviewDatabaseReader {
  inspect(snapshotPath: string): Promise<DatabaseInspection>;
}

async function copyDatabase(
  source: string,
  target: string,
  inventory: Inventory,
): Promise<Map<string, string> | null> {
  const snapshots = new Map<string, string>();
  for (const suffix of ["", "-wal"]) {
    const file = source + suffix;
    const issueCount = inventory.issues.length;
    if (!(await regularPath(file, inventory))) {
      if (inventory.issues.length !== issueCount) return null;
      continue;
    }
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_DATABASE_BYTES) {
      inventory.issues.push({ code: "database-size-or-type-limit", path: file });
      return null;
    }
    await copyFile(file, target + suffix);
    const digest = await hash(target + suffix);
    snapshots.set(suffix, digest);
    if (digest !== (await hash(file))) {
      inventory.issues.push({ code: "database-changed-during-preview", path: source });
      return null;
    }
  }
  return snapshots;
}

function readEdges(db: InventoryDatabase): DatabaseInspection {
  const columns = db.prepare("PRAGMA table_info(thread_spawn_edges)").all();
  const names = new Set(columns.map((column) => Column.parse(column).name));
  const recognized = names.has("parent_thread_id") && names.has("child_thread_id");
  if (!recognized) return { schema: "unsupported", edges: [], issue: null };
  const rows = db
    .prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges LIMIT 10001")
    .all();
  if (rows.length > MAX_FILES) {
    return { schema: "unsupported", edges: [], issue: "database-row-limit" };
  }
  const edges = rows.map((row) => {
    const edge = Edge.parse(row);
    return { parent: edge.parent_thread_id, child: edge.child_thread_id };
  });
  return { schema: "recognized-inventory", edges, issue: null };
}

async function inspectDatabase(target: string): Promise<DatabaseInspection> {
  // The repository's Node 20 declarations predate the optional runtime builtin.
  const specifier: string = "node:sqlite";
  let module: unknown;
  try {
    module = await import(specifier);
  } catch (error) {
    const unavailable =
      error instanceof Error && "code" in error && error.code === "ERR_UNKNOWN_BUILTIN_MODULE";
    const code = unavailable ? "sqlite-runtime-unavailable" : "database-unreadable-or-unsupported";
    return { schema: "runtime-unavailable", edges: [], issue: code };
  }
  try {
    const { DatabaseSync } = SqliteModuleSchema.parse(module);
    const db = new DatabaseSync(target, { readOnly: true });
    try {
      return readEdges(db);
    } finally {
      db.close();
    }
  } catch {
    // SQLite errors can include arbitrary schema text; expose a fixed code only.
    return { schema: "unsupported", edges: [], issue: "database-unreadable-or-unsupported" };
  }
}

export const sqliteHistoryReader: HistoryPreviewDatabaseReader = { inspect: inspectDatabase };

async function verifyDatabaseSnapshot(
  source: string,
  snapshots: Map<string, string>,
  inventory: Inventory,
): Promise<boolean> {
  let unchanged = true;
  for (const suffix of ["", "-wal"]) {
    let current: string | undefined;
    try {
      current = await hash(source + suffix);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (current !== snapshots.get(suffix)) {
      inventory.issues.push({ code: "database-changed-during-preview", path: source });
      unchanged = false;
    }
  }
  return unchanged;
}

// SQLite can create SHM files even when opened read-only. Open only a disposable copy,
// including WAL, and reject a source that changes while it is being copied. No source locks.
export async function database(
  source: string,
  inventory: Inventory,
  reader: HistoryPreviewDatabaseReader,
): Promise<DatabaseSnapshot | null> {
  if (!(await regularPath(source, inventory))) {
    inventory.issues.push({ code: "database-missing-or-linked", path: source });
    return null;
  }
  const temporary = await mkdtemp(path.join(tmpdir(), "paseo-history-preview-"));
  try {
    const target = path.join(temporary, "state.sqlite");
    const snapshots = await copyDatabase(source, target, inventory);
    if (!snapshots) return null;
    const inspection = await reader.inspect(target);
    if (inspection.issue) inventory.issues.push({ code: inspection.issue, path: source });
    if (inspection.schema === "unsupported")
      inventory.issues.push({ code: "database-schema-unsupported", path: source });
    const unchanged = await verifyDatabaseSnapshot(source, snapshots, inventory);
    const usable = unchanged && inspection.schema === "recognized-inventory";
    const edges = usable ? inspection.edges : [];
    return {
      database: {
        source,
        sha256: await hash(target),
        walSha256: snapshots.get("-wal") ?? null,
        schema: inspection.schema,
        snapshot: unchanged ? "unverified" : "invalid",
      },
      edges,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
