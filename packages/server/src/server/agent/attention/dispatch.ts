import type { Logger } from "pino";
import type { AgentManager } from "../agent-manager.js";
import type { AttentionAdmission } from "./objectives.js";

/**
 * Run one agent message dispatch and record its attention admissions as rejected when it fails.
 *
 * The dispatch failure is always the error the caller sees. If recording the rejection also
 * fails, that second failure is logged and the original error still propagates, so batch
 * receipts settle on the real cause.
 */
export async function dispatchWithAttentionRejection<T>(input: {
  agentManager: Pick<AgentManager, "recordAttentionRejection">;
  logger: Pick<Logger, "error">;
  recipientId: string;
  admissions: readonly AttentionAdmission[];
  dispatch: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.dispatch();
  } catch (error) {
    try {
      await input.agentManager.recordAttentionRejection({
        agentId: input.recipientId,
        admissions: input.admissions,
        error: error instanceof Error ? error.message : "Agent request dispatch failed",
      });
    } catch (recordingError) {
      input.logger.error(
        { err: recordingError, agentId: input.recipientId },
        "Failed to record rejected attention admissions",
      );
    }
    throw error;
  }
}
