import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import { buildAgentMessageDisplay } from "@getpaseo/protocol/paseo-tool-presentation/index";
import type { PlanOutcome } from "@/components/plan-card";
import type { ComponentType } from "react";
import type { TFunction } from "i18next";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { ToolCallDisplayInput } from "@/utils/tool-call-display";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";
import { extractToolCallFilePath } from "@/utils/extract-tool-call-file-path";
import {
  hasMeaningfulToolCallDetail,
  isPendingToolCallDetail,
} from "@/utils/tool-call-detail-state";
import { activityIconDetail, buildActivityDisplay } from "./activity";
import { splitReadableFileBatch, type AdditionalFile } from "./additional-files";

type ToolCallStatus = "executing" | "running" | "completed" | "failed" | "canceled";
export type ToolCallPresentationIcon = ComponentType<{ size?: number; color?: string }>;

interface BuildToolCallPresentationInput {
  agentMessage?: AgentMessage;
  toolName: string;
  status: ToolCallStatus;
  error: unknown;
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  targetAgentTitle?: string;
  resolveIcon: ToolCallIconResolver;
  /** Translator for readable activity labels; absent keeps the classic labels. */
  activityTranslation?: TFunction;
}

export interface ToolCallPresentation {
  detail: ToolCallDetail | undefined;
  displayName: string;
  summary?: string;
  errorText?: string;
  icon: ToolCallPresentationIcon;
  isLoadingDetails: boolean;
  hasDetails: boolean;
  canOpenDetails: boolean;
  openFilePath: string | null;
  /** Patch files beyond the one `detail` shows; only with readable activity on. */
  additionalFiles: readonly AdditionalFile[];
  isPlan: boolean;
  planOutcome?: PlanOutcome;
}

export type ToolCallIconResolver = (
  toolName: string,
  detail: ToolCallDetail | undefined,
  agentMessage: AgentMessage | undefined,
) => ToolCallPresentationIcon;

function displayStatus(status: ToolCallStatus): ToolCallDisplayInput["status"] {
  return status === "executing" ? "running" : status;
}

function displayDetail(detail: ToolCallDetail | undefined): ToolCallDetail {
  return detail ?? { type: "unknown", input: null, output: null };
}

/** Build one row/detail policy; an absent translator retains classic tool labels. */
export function buildToolCallPresentation(
  input: BuildToolCallPresentationInput,
): ToolCallPresentation {
  const sourceDetail = input.agentMessage
    ? buildAgentMessageDisplay(input.agentMessage).detail
    : input.detail;
  const { detail, additionalFiles } = splitReadableFileBatch(sourceDetail, {
    readable: Boolean(input.activityTranslation),
    agentMessage: input.agentMessage,
    metadata: input.metadata,
    cwd: input.cwd,
  });
  const detailForDisplay = displayDetail(sourceDetail);
  const displayModel = buildToolCallDisplayModel({
    name: input.toolName,
    agentMessage: input.agentMessage,
    status: displayStatus(input.status),
    error: input.error ?? null,
    detail: detailForDisplay,
    metadata: input.metadata,
    cwd: input.cwd,
    targetAgentTitle: input.targetAgentTitle,
  });
  const activity = input.activityTranslation
    ? buildActivityDisplay(
        {
          agentMessage: input.agentMessage,
          status: displayStatus(input.status),
          detail: detailForDisplay,
          metadata: input.metadata,
          cwd: input.cwd,
        },
        input.activityTranslation,
      )
    : undefined;
  const labels = activity ?? displayModel;
  const iconDetail = activityIconDetail(sourceDetail, activity?.kind);
  const isLoadingDetails = isPendingToolCallDetail({
    detail,
    status: input.status,
    error: input.error,
  });
  const hasDetails =
    Boolean(input.error) || hasMeaningfulToolCallDetail(detail) || additionalFiles.length > 0;

  return {
    detail,
    displayName: labels.displayName,
    summary: labels.summary,
    errorText: displayModel.errorText,
    icon: input.resolveIcon(input.toolName, iconDetail, input.agentMessage),
    isLoadingDetails,
    hasDetails,
    canOpenDetails: hasDetails || isLoadingDetails,
    openFilePath: extractToolCallFilePath(detail),
    additionalFiles,
    isPlan: input.detail?.type === "plan",
    planOutcome: input.detail?.type === "plan" ? resolvePlanOutcome(input) : undefined,
  };
}

function resolvePlanOutcome(input: BuildToolCallPresentationInput): PlanOutcome | undefined {
  if (input.status === "canceled") return "canceled";
  if (input.metadata?.approved === false) return "rejected";
  if (input.metadata?.approved === true) return "approved";
  if (input.status === "running" || input.status === "executing") return "pending";
  return undefined;
}
