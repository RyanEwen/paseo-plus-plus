import type { ArchivedWorkspaceSummary } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  listProjectArchivedWorkspaces,
  resolveProjectRestoreHosts,
  selectArchivedWorkspaceRows,
  type ArchivedWorkspaceListingClient,
  type ArchivedWorkspaceListingPort,
} from "./project-archive-restore";

function summary(input: Partial<ArchivedWorkspaceSummary> = {}): ArchivedWorkspaceSummary {
  return {
    workspaceId: "archived-1",
    workspaceName: "feature",
    workspaceDirectory: "/repo/.paseo/worktrees/feature",
    branch: "feature/archive",
    archivedAt: "2026-10-21T00:00:00.000Z",
    ...input,
  };
}

/** In-memory hosts: each host either answers with entries, rejects, or is absent. */
function fakePort(input: {
  answers: Record<string, ArchivedWorkspaceSummary[] | Error>;
  unsupported?: string[];
}) {
  const requests: Array<{ serverId: string; projectId: string; includeBackground?: boolean }> = [];
  const clientFor = (serverId: string): ArchivedWorkspaceListingClient => ({
    listArchivedProjectWorkspaces: async (request) => {
      requests.push({ serverId, ...request });
      const answer = input.answers[serverId];
      if (answer instanceof Error) {
        throw answer;
      }
      return answer ?? [];
    },
  });
  const port: ArchivedWorkspaceListingPort = {
    getConnectedClient: (serverId) => (serverId in input.answers ? clientFor(serverId) : null),
    supportsListing: (serverId) => !(input.unsupported ?? []).includes(serverId),
  };
  return { port, requests };
}

describe("resolveProjectRestoreHosts", () => {
  it("lists every host a multi-host project is open on", () => {
    const hosts = [
      { serverId: "host-a", projectId: "project-a" },
      { serverId: "host-b", projectId: "project-b" },
    ];
    expect(resolveProjectRestoreHosts({ hosts })).toEqual(hosts);
  });
});

describe("listProjectArchivedWorkspaces", () => {
  it("asks a connected, supporting host for the project's records with the background choice", async () => {
    const entries = [summary()];
    const { port, requests } = fakePort({ answers: { "host-a": entries } });
    const listings = await listProjectArchivedWorkspaces({
      hosts: [{ serverId: "host-a", projectId: "project-a" }],
      includeBackground: true,
      port,
    });
    expect(listings).toEqual([{ kind: "loaded", serverId: "host-a", entries }]);
    expect(requests).toEqual([
      { serverId: "host-a", projectId: "project-a", includeBackground: true },
    ]);
  });

  it("reports a disconnected host and an outdated host without requesting from either", async () => {
    const { port, requests } = fakePort({ answers: { "host-old": [] }, unsupported: ["host-old"] });
    const listings = await listProjectArchivedWorkspaces({
      hosts: [
        { serverId: "host-offline", projectId: "project-a" },
        { serverId: "host-old", projectId: "project-a" },
      ],
      includeBackground: false,
      port,
    });
    expect(listings).toEqual([
      { kind: "disconnected", serverId: "host-offline" },
      { kind: "unsupported", serverId: "host-old" },
    ]);
    expect(requests).toEqual([]);
  });

  it("keeps one host's failure from hiding another host's records", async () => {
    const failure = new Error("The project no longer exists on this host.");
    const entries = [summary({ workspaceId: "kept" })];
    const { port } = fakePort({ answers: { "host-a": failure, "host-b": entries } });
    const listings = await listProjectArchivedWorkspaces({
      hosts: [
        { serverId: "host-a", projectId: "project-a" },
        { serverId: "host-b", projectId: "project-b" },
      ],
      includeBackground: false,
      port,
    });
    expect(listings).toEqual([
      { kind: "failed", serverId: "host-a", error: failure },
      { kind: "loaded", serverId: "host-b", entries },
    ]);
  });
});

describe("selectArchivedWorkspaceRows", () => {
  const listings = [
    {
      kind: "loaded" as const,
      serverId: "host-a",
      entries: [
        summary({ workspaceId: "a-1", workspaceName: "Docs", branch: null }),
        summary({ workspaceId: "a-2", workspaceName: "API", branch: "feature/api" }),
      ],
    },
    { kind: "failed" as const, serverId: "host-c", error: new Error("offline") },
    {
      kind: "loaded" as const,
      serverId: "host-b",
      entries: [summary({ workspaceId: "b-1", workspaceName: "Mobile", branch: "feature/api-v2" })],
    },
  ];

  it("lists every loaded host's records in host order with their owning host", () => {
    expect(
      selectArchivedWorkspaceRows(listings, "").map((row) => [row.serverId, row.entry.workspaceId]),
    ).toEqual([
      ["host-a", "a-1"],
      ["host-a", "a-2"],
      ["host-b", "b-1"],
    ]);
  });

  it("matches the name, branch or directory case-insensitively", () => {
    expect(
      selectArchivedWorkspaceRows(listings, "  FEATURE/API ").map((row) => row.entry.workspaceId),
    ).toEqual(["a-2", "b-1"]);
    expect(selectArchivedWorkspaceRows(listings, "docs").map((row) => row.entry.workspaceId)).toEqual([
      "a-1",
    ]);
  });
});
