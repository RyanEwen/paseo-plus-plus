import { z } from "zod";
import type { ConfiguredHistoryStorage } from "../binding.js";

export const MAX_FILES = 10_000;
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
export const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
export const CodexHeader = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: Identifier,
    parent_thread_id: Identifier.nullable().optional(),
    forked_from_id: Identifier.nullable().optional(),
  }),
});
export const ClaudeHeader = z.object({ sessionId: Identifier });
export const Edge = z.object({ parent_thread_id: Identifier, child_thread_id: Identifier });

export interface HistoryPreviewInput {
  paseoHome: string;
  provider: string;
  family: "codex" | "claude";
  providerHome: string;
  sqliteHome?: string;
  destinationProvider?: string;
}

interface PreviewIssue {
  code: string;
  path: string;
}
export interface SessionFile {
  id: string;
  source: string;
  bytes: number;
  sha256: string;
  parents: string[];
}
export interface SessionCandidate extends SessionFile {
  agentIds: string[];
  provenance: "created" | "imported" | "legacy" | "descendant" | "native-only" | "conflict";
  disposition: "preserve" | "needs-classification";
}
export interface ArtifactInventory {
  source: string;
  bytes: number;
  sha256: string;
}
export interface DatabaseInventory {
  source: string;
  sha256: string;
  walSha256: string | null;
  schema: "recognized-inventory" | "unsupported" | "runtime-unavailable";
  snapshot: "unverified" | "invalid";
}
export interface UnresolvedHistoryIntent {
  agentId: string;
  origin: "created" | "imported" | "legacy";
  requestedSessionId: string | null;
  workspaceId: string | null;
  configFields: string[];
}
export interface ProviderHistoryPreview {
  provider: string;
  family: HistoryPreviewInput["family"];
  providerHome: string;
  digest: string;
  applySupported: false;
  sessions: SessionCandidate[];
  missingSessionIds: string[];
  unresolvedAgentIds: string[];
  unresolvedIntents: UnresolvedHistoryIntent[];
  databases: DatabaseInventory[];
  artifacts: ArtifactInventory[];
  issues: PreviewIssue[];
  destination?: {
    provider: string;
    admission: "configured" | "conflict" | "unavailable";
    storage?: ConfiguredHistoryStorage;
    sourceOverlap: boolean;
    collidingSessionIds: string[];
    inventoryDigest?: string;
    sessionCount?: number;
    issues: PreviewIssue[];
  };
}
export interface Inventory {
  issues: PreviewIssue[];
  visited: number;
}
export interface InventoryDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}
export interface SpawnEdge {
  parent: string;
  child: string;
}
