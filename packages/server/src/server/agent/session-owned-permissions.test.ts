import { expect, test } from "vitest";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";
import { survivesTurnCancellation } from "./session-owned-permissions.js";

const asyncQuestion: AgentPermissionRequest = {
  id: "permission-async-question-1",
  provider: "codex",
  name: "request_user_input_async",
  kind: "question",
};

const commandApproval: AgentPermissionRequest = {
  id: "permission-command-1",
  provider: "codex",
  name: "Bash",
  kind: "tool",
};

function sessionHolding(...requests: AgentPermissionRequest[]) {
  return { getPendingPermissions: () => requests };
}

test("keeps a Codex async question the session still holds", () => {
  expect(survivesTurnCancellation(sessionHolding(asyncQuestion), asyncQuestion)).toBe(true);
});

test("drops a Codex async question the session no longer holds", () => {
  expect(survivesTurnCancellation(sessionHolding(), asyncQuestion)).toBe(false);
});

test("drops turn-scoped approvals even while the session still lists them", () => {
  expect(survivesTurnCancellation(sessionHolding(commandApproval), commandApproval)).toBe(false);
});

test("drops a same-named question from another provider", () => {
  const claudeQuestion = { ...asyncQuestion, provider: "claude" as const };
  expect(survivesTurnCancellation(sessionHolding(claudeQuestion), claudeQuestion)).toBe(false);
});
