import { afterEach, describe, expect, it } from "vitest";
import {
  consumeWorkspaceRecoveryRequest,
  isWorkspaceRecoveryRequested,
  requestWorkspaceRecovery,
} from "./workspace-recovery-intent";

const archived = { serverId: "archive-host", workspaceId: "archived-workspace" };
const other = { serverId: "archive-host", workspaceId: "other-workspace" };

afterEach(() => {
  consumeWorkspaceRecoveryRequest("archive-host:archived-workspace");
  consumeWorkspaceRecoveryRequest("archive-host:other-workspace");
});

describe("workspace recovery intent", () => {
  it("records a request under the workspace layout key only", () => {
    requestWorkspaceRecovery(archived);
    expect(isWorkspaceRecoveryRequested("archive-host:archived-workspace")).toBe(true);
    expect(isWorkspaceRecoveryRequested("archive-host:other-workspace")).toBe(false);
    expect(isWorkspaceRecoveryRequested(null)).toBe(false);
  });

  it("consumes one workspace's request without touching another's", () => {
    requestWorkspaceRecovery(archived);
    requestWorkspaceRecovery(other);
    consumeWorkspaceRecoveryRequest("archive-host:archived-workspace");
    expect(isWorkspaceRecoveryRequested("archive-host:archived-workspace")).toBe(false);
    expect(isWorkspaceRecoveryRequested("archive-host:other-workspace")).toBe(true);
  });

  it("ignores a target without a host or workspace identity", () => {
    requestWorkspaceRecovery({ serverId: " ", workspaceId: "archived-workspace" });
    expect(isWorkspaceRecoveryRequested(" :archived-workspace")).toBe(false);
    expect(isWorkspaceRecoveryRequested(":archived-workspace")).toBe(false);
  });
});
