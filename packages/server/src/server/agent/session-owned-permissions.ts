import type { AgentPermissionRequest, AgentSession } from "./agent-sdk-types.js";

/**
 * Permission name of a Codex async question, as built by `toPermission` in
 * `providers/codex/async-questions.ts`.
 */
const CODEX_ASYNC_QUESTION_NAME = "request_user_input_async";

/**
 * Decides whether a pending permission outlives the canceled or failed turn that raised it.
 *
 * Paseo++ keeps Codex async questions open after Stop, an interruption or a failed turn: the answer belongs
 * to the session, not the turn. Turn-scoped approvals are still denied, because the provider
 * ends them with the turn. A question is kept only while the session itself still reports
 * it pending, so the manager never publishes a request the session no longer holds.
 *
 * @param session The agent's live provider session.
 * @param request A request from the manager's published pending set.
 * @returns True when the manager must keep publishing the request after the turn ends.
 */
export function survivesTurnEnd(
  session: Pick<AgentSession, "getPendingPermissions">,
  request: AgentPermissionRequest,
): boolean {
  if (request.provider !== "codex" || request.name !== CODEX_ASYNC_QUESTION_NAME) {
    return false;
  }
  return session.getPendingPermissions().some((pending) => pending.id === request.id);
}
