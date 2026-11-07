import { describe, expect, test } from "vitest";
import { AttentionBlockers, type AttentionBlockerMember } from "./blockers.js";

const requester = { agentId: "requester", serverId: "home" };

function members(): AttentionBlockerMember[] {
  return [{ objectiveId: "objective", requester, isCurrent: () => true }];
}

/** Escalations a verification run raised, given how the requester resolves. */
async function verifyWith(
  blockers: AttentionBlockers,
  availability: "available" | "missing" | "unknown",
): Promise<string[]> {
  const escalated: string[] = [];
  await blockers.verify({
    resolveRequester: async () => availability,
    isCurrent: () => true,
    escalate: async ({ objectiveId, reason }) => {
      escalated.push(`${objectiveId}:${reason}`);
    },
  });
  return escalated;
}

describe("AttentionBlockers", () => {
  test("escalates an observed permission only when its requester is verified missing", async () => {
    const blockers = new AttentionBlockers(undefined, members, "home");
    blockers.admit({ turnId: "turn", steering: false });
    blockers.observePermission({ turnId: "turn", permissionId: "permission" });

    expect(await verifyWith(blockers, "available")).toEqual([]);
    expect(await verifyWith(blockers, "unknown")).toEqual([]);
    expect(await verifyWith(blockers, "missing")).toEqual(["objective:permission"]);
  });

  test("keeps a restored permission dormant until the provider reports it still pending", async () => {
    const source = new AttentionBlockers(undefined, members, "home");
    source.admit({ turnId: "turn", steering: false });
    source.observePermission({ turnId: "turn", permissionId: "permission" });
    const restored = new AttentionBlockers(source.snapshot(), members, "home");

    expect(await verifyWith(restored, "missing")).toEqual([]);
    restored.synchronizePermissions(["permission"]);
    expect(await verifyWith(restored, "missing")).toEqual(["objective:permission"]);
  });

  test("prunes a restored permission the provider no longer reports", async () => {
    const source = new AttentionBlockers(undefined, members, "home");
    source.admit({ turnId: "turn", steering: false });
    source.observePermission({ turnId: "turn", permissionId: "permission" });
    const restored = new AttentionBlockers(source.snapshot(), members, "home");

    restored.synchronizePermissions([]);
    expect(restored.snapshot()).toEqual([]);
  });

  test("ignores a permission from another turn and retires checkpoints on a new turn", async () => {
    const blockers = new AttentionBlockers(undefined, members, "home");
    blockers.admit({ turnId: "turn", steering: false });
    blockers.observePermission({ turnId: "other-turn", permissionId: "late" });
    expect(blockers.snapshot()).toEqual([]);

    blockers.observePermission({ turnId: "turn", permissionId: "permission" });
    blockers.admit({ turnId: "next-turn", steering: false });
    expect(await verifyWith(blockers, "missing")).toEqual([]);
  });

  test("a host rebind retires verification already in flight", async () => {
    const blockers = new AttentionBlockers(undefined, members, "home");
    blockers.admit({ turnId: "turn", steering: false });
    blockers.observePermission({ turnId: "turn", permissionId: "permission" });
    const escalated: string[] = [];
    await blockers.verify({
      resolveRequester: async () => {
        blockers.bindHost("new-route");
        return "missing";
      },
      isCurrent: () => true,
      escalate: async ({ objectiveId }) => {
        escalated.push(objectiveId);
      },
    });

    expect(escalated).toEqual([]);
  });
});
