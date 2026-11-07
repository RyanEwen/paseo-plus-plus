import type {
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentRewindInput,
} from "../agent-sdk-types.js";
import type {
  ClaudeFreshRewindContext,
  ClaudeInitialHistoryContext,
  CommitClaudeRewind,
} from "./claude-identity-types.js";

/**
 * A derived provider (e.g. claude-work) relabels persistence handles as it crosses the registry
 * wrapper. These helpers apply that relabelling to every handle inside the Claude identity
 * contexts and rewind callbacks.
 */
type HandleMapper = (handle: AgentPersistenceHandle | null) => AgentPersistenceHandle | null;

function mapClaudeRewindCommit(
  commit: CommitClaudeRewind,
  mapHandle: HandleMapper,
): CommitClaudeRewind {
  return (transition) =>
    commit({
      ...transition,
      previous: mapHandle(transition.previous)!,
      next: transition.next ? mapHandle(transition.next)! : undefined,
      adopt: (fresh) =>
        transition.adopt(fresh ? mapClaudeFreshContext(fresh, mapHandle) : undefined),
    });
}
function mapClaudeFreshContext(
  context: ClaudeFreshRewindContext,
  mapHandle: HandleMapper,
): ClaudeFreshRewindContext {
  return {
    ...context,
    get admission() {
      return context.admission;
    },
    commit: mapClaudeRewindCommit(context.commit, mapHandle),
  };
}
function mapInitialHistoryContext(
  context: ClaudeInitialHistoryContext,
  mapHandle: HandleMapper,
): ClaudeInitialHistoryContext {
  return {
    ...context,
    get admission() {
      return context.admission;
    },
    commit: (input) => context.commit({ ...input, next: mapHandle(input.next)! }),
  };
}
export function mapClaudeIdentityLaunchContext(
  context: AgentLaunchContext | undefined,
  mapHandle: HandleMapper,
): AgentLaunchContext | undefined {
  return context && (context.claudeFreshRewind || context.claudeInitialHistory)
    ? {
        ...context,
        claudeFreshRewind: context.claudeFreshRewind
          ? mapClaudeFreshContext(context.claudeFreshRewind, mapHandle)
          : undefined,
        claudeInitialHistory: context.claudeInitialHistory
          ? mapInitialHistoryContext(context.claudeInitialHistory, mapHandle)
          : undefined,
      }
    : context;
}
export function mapClaudeRewindInput(
  input: AgentRewindInput,
  mapHandle: HandleMapper,
): AgentRewindInput {
  return input.commitClaudeRewind
    ? { ...input, commitClaudeRewind: mapClaudeRewindCommit(input.commitClaudeRewind, mapHandle) }
    : input;
}
