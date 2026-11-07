import { expect, test } from "vitest";
import { AgentAttentionObjectives, AttentionObjectiveError } from "./objectives.js";

test("waiting human objectives survive serialization, unrelated work, and authenticated callbacks", () => {
  let objectives = new AgentAttentionObjectives(undefined, "home");
  objectives.admit({ inputs: [{ kind: "human", requestId: "human-job" }], steering: false });
  objectives.declare("human-job", "waiting");
  const reply = objectives.outgoing({
    recipient: { agentId: "worker", serverId: "remote" },
    objectiveId: undefined,
    requestId: "first-request",
  });
  expect(reply?.requesterObjective).toEqual({
    objectiveId: "human-job",
    requestId: "first-request",
    token: expect.any(String),
  });
  expect(
    objectives.outgoing({
      recipient: { agentId: "worker", serverId: "remote" },
      objectiveId: undefined,
      requestId: "first-request",
    }),
  ).toEqual(reply);
  expect(objectives.finish()).toBe(false);
  objectives = new AgentAttentionObjectives(objectives.snapshot(), "home");
  expect(JSON.stringify(objectives.describe())).not.toContain(reply?.requesterObjective?.token);
  objectives.admit({
    inputs: [{ kind: "agent", requestId: "unrelated", requester: { agentId: "other" } }],
    steering: false,
  });
  expect(() => objectives.declare("human-job", "final")).toThrow(AttentionObjectiveError);
  expect(objectives.finish()).toBe(false);
  expect(() =>
    objectives.admit({
      inputs: [
        {
          kind: "agent",
          requestId: "spoofed-reply",
          requester: { agentId: "worker", serverId: "wrong-host" },
          attention: { continuation: reply?.requesterObjective },
        },
      ],
      steering: false,
    }),
  ).toThrow(AttentionObjectiveError);
  expect(objectives.hasHumanAudience()).toBe(false);
  expect(objectives.finish()).toBe(false);
  objectives.admit({
    inputs: [
      {
        kind: "agent",
        requestId: "actual-reply",
        requester: { agentId: "worker", serverId: "remote" },
        attention: { continuation: reply?.requesterObjective },
      },
    ],
    steering: false,
  });
  expect(objectives.hasHumanAudience()).toBe(true);
  expect(objectives.finish()).toBe(false);
  objectives.declare("human-job", "final");
  expect(objectives.finish()).toBe(true);
  expect(() =>
    objectives.admit({
      inputs: [
        {
          kind: "agent",
          requestId: "late-reply",
          requester: { agentId: "worker", serverId: "remote" },
          attention: { continuation: reply?.requesterObjective },
        },
      ],
      steering: false,
    }),
  ).toThrow(AttentionObjectiveError);
  expect(objectives.hasHumanAudience()).toBe(false);
});

test("steering joins human obligations while unrelated replacement keeps objectives separate", () => {
  const objectives = new AgentAttentionObjectives();
  objectives.admit({ inputs: [{ kind: "human", requestId: "human" }], steering: false });
  objectives.admit({
    inputs: [{ kind: "agent", requestId: "agent", requester: { agentId: "caller" } }],
    steering: true,
  });
  expect(objectives.hasHumanAudience()).toBe(true);
  expect(() => objectives.outgoing({ recipient: { agentId: "worker" } })).toThrow(
    AttentionObjectiveError,
  );
  objectives.declare("human", "waiting");
  objectives.admit({
    inputs: [{ kind: "agent", requestId: "other", requester: { agentId: "caller" } }],
    steering: false,
  });
  expect(objectives.hasHumanAudience()).toBe(false);
  expect(objectives.requiresHumanAttention({ hasUnread: false, hasProblem: true })).toBe(false);
  expect(objectives.requiresHumanAttention({ hasUnread: true, hasProblem: false })).toBe(true);
  const lease = objectives.reserveHumanAttention("other", "Pick an account");
  if (!lease) throw new Error("Expected a first human attention reservation");
  objectives.commitHumanAttention(lease);
  // A retry of the same reason stays quiet after restart; a new reason escalates again.
  const restored = new AgentAttentionObjectives(objectives.snapshot());
  expect(restored.reserveHumanAttention("other", "Pick an account")).toBeNull();
  expect(restored.reserveHumanAttention("other", "Approve deployment")).toEqual(expect.any(Symbol));
});

test("permission continuation admission rejects later accepted work even for the same objective", () => {
  const objectives = new AgentAttentionObjectives();
  objectives.admit({
    inputs: [{ kind: "agent", requestId: "task", requester: { agentId: "requester" } }],
    steering: false,
  });
  const captured = objectives.capture();
  if (captured.kind !== "continuation") throw new Error("Expected a permission continuation");
  objectives.assertContinuation(captured);
  objectives.admit({
    inputs: [{ kind: "agent", requestId: "task", requester: { agentId: "requester" } }],
    steering: true,
  });
  expect(() => objectives.assertContinuation(captured)).toThrow(AttentionObjectiveError);
});

test("exact completed outcomes retain their own full content through later acceptance and restart", () => {
  const requester = { agentId: "caller", serverId: "origin" };
  const a = {
    kind: "agent" as const,
    requestId: "request-A",
    requester,
    attention: {
      requesterObjective: { objectiveId: "caller-job", token: "cap-A", requestId: "request-A" },
    },
  };
  const b = {
    kind: "agent" as const,
    requestId: "request-B",
    requester,
    attention: {
      requesterObjective: { objectiveId: "caller-job", token: "cap-B", requestId: "request-B" },
    },
  };
  let target = new AgentAttentionObjectives(undefined, "target");
  target.admit({ inputs: [a], steering: false, acceptance: { turnId: "SDK-A" } });
  target.requests.updateContent("SDK-A", "Complete A result".repeat(1000));
  target.requests.record({ turnId: "SDK-A", kind: "finished" });
  target.finish();
  target.admit({ inputs: [b], steering: false, acceptance: { turnId: "SDK-B" } });
  target.requests.updateContent("SDK-B", "Unrelated B");
  target.requests.record({ turnId: "SDK-B", kind: "finished" });
  target = new AgentAttentionObjectives(target.snapshot(), "target");
  const query = { requester, link: a.attention.requesterObjective };
  const outcome = target.requests.read(query).outcome;
  expect(outcome).toMatchObject({
    kind: "finished",
    requestId: "request-A",
    acceptedTurnId: "SDK-A",
    lastMessage: "Complete A result".repeat(1000),
  });
  expect(target.requests.read({ ...query, acknowledgeOutcomeId: outcome?.id }).outcome).toBeNull();
  expect(
    target.requests.read({ requester, link: b.attention.requesterObjective }).outcome?.lastMessage,
  ).toBe("Unrelated B");
});

test("a rejected queued request and a replaced active request cannot borrow a later result", () => {
  const requester = { agentId: "caller" };
  const request = (id: string) => ({
    kind: "agent" as const,
    requestId: id,
    requester,
    attention: { requesterObjective: { objectiveId: "caller-job", token: id, requestId: id } },
  });
  const target = new AgentAttentionObjectives();
  const failed = request("failed");
  target.requests.reject([failed], "Exact submission failed");
  const a = request("active-A");
  target.admit({ inputs: [a], steering: false, acceptance: { turnId: "SDK-A" } });
  target.requests.updateContent("SDK-A", "A partial result");
  const b = request("later-B");
  target.admit({ inputs: [b], steering: false, acceptance: { turnId: "SDK-B" } });
  target.requests.updateContent("SDK-B", "B output");
  target.requests.record({ turnId: "SDK-B", kind: "finished" });
  expect(
    target.requests.read({ requester, link: failed.attention.requesterObjective }).outcome,
  ).toMatchObject({
    kind: "rejected",
    acceptedTurnId: null,
    lastMessage: null,
    error: "Exact submission failed",
  });
  expect(
    target.requests.read({ requester, link: a.attention.requesterObjective }).outcome,
  ).toMatchObject({ kind: "canceled", acceptedTurnId: "SDK-A", lastMessage: "A partial result" });
});

test("one SDK turn gives later steers only their own subsequent permission and terminal outcomes", () => {
  const requester = { agentId: "caller" };
  const request = (id: string) => ({
    kind: "agent" as const,
    requestId: id,
    requester,
    attention: { requesterObjective: { objectiveId: "caller-job", token: id, requestId: id } },
  });
  const target = new AgentAttentionObjectives();
  const a = request("A");
  const b = request("B");
  target.admit({ inputs: [a], steering: false, acceptance: { turnId: "SDK" } });
  const first = { id: "permission-1", provider: "codex", name: "Run", kind: "tool" as const };
  target.requests.record({ turnId: "SDK", kind: "permission", permission: first });
  target.admit({ inputs: [b], steering: true, acceptance: { turnId: "SDK" } });
  target.requests.record({ turnId: "SDK", kind: "permission", permission: first });
  expect(
    target.requests.read({ requester, link: b.attention.requesterObjective }).outcome,
  ).toBeNull();
  target.requests.record({
    turnId: "SDK",
    kind: "permission",
    permission: { ...first, id: "permission-2" },
  });
  const bQuery = { requester, link: b.attention.requesterObjective };
  const checkpoint = target.requests.read(bQuery).outcome;
  expect(checkpoint?.permission?.id).toBe("permission-2");
  target.requests.record({ turnId: "SDK", kind: "finished", lastMessage: "Final SDK response" });
  const terminal = target.requests.read({
    ...bQuery,
    acknowledgeOutcomeId: checkpoint?.id,
  }).outcome;
  expect(terminal?.kind).toBe("finished");
  expect(terminal?.id).not.toBe(checkpoint?.id);
});

test("outcome reservation is exclusive, failed admission is retryable, and only acceptance consumes it", () => {
  const source = new AgentAttentionObjectives(undefined, "origin");
  source.admit({ inputs: [{ kind: "human", requestId: "human-job" }], steering: false });
  source.declare("human-job", "waiting");
  const peer = { agentId: "worker", serverId: "target" };
  const attention = source.outgoing({ recipient: peer });
  if (!attention?.requesterObjective) throw new Error("Expected exact request link");
  const link = attention.requesterObjective;
  const requester = { agentId: "caller", serverId: "origin" };
  const outcome = {
    id: "outcome",
    requestId: link.requestId,
    requester,
    acceptedTurnId: "SDK",
    kind: "finished" as const,
    lastMessage: "Own result",
    error: null,
  };
  const original = source.reserveCallback({
    link,
    peer,
    requester,
    outcome,
    deliveryId: "delivery-1",
  });
  if (original.status !== "reserved") throw new Error("Expected original reservation");
  expect(() =>
    source.reserveCallback({ link, peer, requester, outcome, deliveryId: "competitor" }),
  ).toThrow(AttentionObjectiveError);
  expect(() =>
    source.reserveCallback({ link, peer, requester, outcome, deliveryId: "delivery-1" }),
  ).toThrow(AttentionObjectiveError);
  source.releaseCallback({ link, peer, deliveryId: "delivery-1", lease: original.lease });
  const retry = source.reserveCallback({ link, peer, requester, outcome, deliveryId: "retry" });
  if (retry.status !== "reserved") throw new Error("Expected retry reservation");
  // Releasing a retired watcher must not release the replacement's live ownership.
  source.releaseCallback({ link, peer, deliveryId: "retry", lease: original.lease });
  const callback = {
    kind: "agent" as const,
    requestId: "retry",
    requester: peer,
    attention: { continuation: link, delivery: { outcomeId: outcome.id, deliveryId: "retry" } },
  };
  source.assertAdmissions([callback]);
  source.admit({ inputs: [callback], steering: false, acceptance: { accepted: false } });
  source.assertCallbackReservation({
    link,
    peer,
    outcomeId: outcome.id,
    deliveryId: "retry",
    lease: retry.lease,
  });
  source.admit({ inputs: [callback], steering: false, acceptance: { turnId: "source-SDK" } });
  expect(source.reserveCallback({ link, peer, requester, outcome, deliveryId: "retry" })).toEqual({
    status: "consumed",
  });
  expect(() => source.assertAdmissions([callback])).toThrow(AttentionObjectiveError);
  source.declare("human-job", "final");
  source.finish();
  expect(() =>
    source.reserveCallback({ link, peer, requester, outcome, deliveryId: "new" }),
  ).toThrow(AttentionObjectiveError);
});

test("an ordinary agent request cannot claim a human objective by reusing its message ID", () => {
  const objectives = new AgentAttentionObjectives();
  objectives.admit({ inputs: [{ kind: "human", requestId: "human-message" }], steering: false });
  expect(() =>
    objectives.assertAdmissions([
      { kind: "agent", requestId: "human-message", requester: { agentId: "worker" } },
    ]),
  ).toThrow(AttentionObjectiveError);
  expect(objectives.hasHumanAudience()).toBe(true);
});
