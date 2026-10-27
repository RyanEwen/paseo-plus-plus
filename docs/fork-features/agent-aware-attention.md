# Agent-aware attention

Routine results addressed to another agent do not notify you or make a workspace Ready to review. This applies to independent agents and subagents in the same workspace or another workspace. Human tasks keep their final-result obligation when workers and callbacks continue the work.

Agents coordinating delegated human work use `get_attention_context` and `report_objective_status`: declare an objective `waiting` before ending an interim reply, then `final` when its result is ready. Ordinary direct replies still finish automatically. Separate requests keep separate recipients; approving permission alone does not redirect a result to you.

Failed and Needs input stay visible even when the requesting agent owns the problem. The requester receives its existing callbacks. An agent can explicitly request your attention with a reason; if a blocker has a verified missing or archived requester, Paseo also brings it to you. A disconnected host or a closed, resumable chat does not prove the requester is gone. The notification opens the chat that needs your intervention, including a subagent's own workspace and chat.

Existing unread markers and manual Mark unread keep their meaning. Repeating the same unresolved escalation reason does not notify again. Restart restores known recipients without replaying notifications. Older work with unknown recipients retains its previous behavior; standalone schedules, heartbeats and provider work remain human-facing unless associated with a known objective. Notification preferences and clearing behavior still apply.

Use **Settings → Notifications → Agent-aware attention** to choose attention behavior for the selected host across its devices. The switch starts enabled. Turning it off restores routine notification and Ready-badge behavior while preserving recipients, ongoing work, callbacks, manual unread and existing results. Explicit human escalation and verified requester-loss intervention remain available in both modes. Changing the setting refreshes current indicators without replaying old notifications.

Use updated app and host versions for consistent human badges, Ready status and navigation. Optional wire fields keep older clients compatible, but their badges do not understand the audience decision. Older hosts ask you to update before changing this control or delegating with objective metadata.

Stop keeps its existing interruption behavior. Job-level Pause, Resume and Cancel controls are a separate follow-up. Terminal notifications and notification receipt synchronization are outside this feature.

[Feature branch](https://github.com/RyanEwen/paseo-plus-plus/tree/feat/agent-aware-attention).
