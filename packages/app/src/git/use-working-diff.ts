import { useCallback, useEffect, useMemo } from "react";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  buildReviewDraftKey,
  useInlineReviewController,
  useReviewAttachmentSnapshot,
  useReviewFeedback,
} from "@/review";
import { useSessionStore } from "@/stores/session-store";
import { diffEntryHeaders } from "./diff-snapshot";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useWorkingDiffComparison } from "@/git/working-diff-comparison";

interface UseWorkingDiffOptions {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  ignoreWhitespace: boolean;
  enabled: boolean;
  queryScope?: string;
  filePath?: string;
  includeFileOverview?: boolean;
  presentation?: string;
}

function useWorkingDiffQueries({
  filePath,
  includeFileOverview,
  ...options
}: Parameters<typeof useCheckoutDiffQuery>[0] & { includeFileOverview: boolean }) {
  const queryScope = options.queryScope;
  const overviewQuery = useCheckoutDiffQuery({
    ...options,
    enabled: options.enabled && filePath !== undefined && includeFileOverview,
    queryScope: `${queryScope ?? ""}:working-diff-overview`,
  });
  const fileQuery = useCheckoutDiffQuery({
    ...options,
    filePath,
    enabled: options.enabled,
  });
  // A scoped document keeps the whole comparison for the tree when the overview is kept.
  const overview = filePath !== undefined && includeFileOverview ? overviewQuery : fileQuery;
  return {
    ...fileQuery,
    overviewFiles: overview.files,
    overviewEntries: overview.entries,
  };
}

export function useWorkingDiff({
  serverId,
  workspaceId,
  cwd,
  ignoreWhitespace,
  enabled,
  queryScope,
  filePath,
  includeFileOverview = false,
  presentation,
}: UseWorkingDiffOptions) {
  const {
    status,
    isLoading: isStatusLoading,
    isError: isStatusError,
    error: statusError,
  } = useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = status && status.isGit ? status : null;
  const isGit = Boolean(gitStatus);
  const notGit = status !== null && !status.isGit && !status.error;
  const statusErrorMessage =
    status?.error?.message ??
    (isStatusError && statusError instanceof Error ? statusError.message : null);
  const modernDiff = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.diffSubscription === true,
  );
  // COMPAT(diffSubscription): added in v0.15.0, remove after 2027-05-06.
  const baseRef = (modernDiff ? gitStatus?.comparisonBaseRef : gitStatus?.baseRef) ?? undefined;
  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);
  const currentBranchName =
    gitStatus?.currentBranch && gitStatus.currentBranch !== "HEAD" ? gitStatus.currentBranch : null;

  const {
    comparison: diffMode,
    selectComparison,
    isLoading: comparisonLoading,
  } = useWorkingDiffComparison({
    serverId,
    workspaceId,
    cwd,
    isDirty: hasUncommittedChanges,
    statusReady: status !== null,
  });
  const selectUncommitted = useCallback(() => selectComparison("uncommitted"), [selectComparison]);
  const selectAll = useCallback(() => selectComparison("all"), [selectComparison]);
  const selectBase = useCallback(() => selectComparison("base"), [selectComparison]);

  const queryOptions = {
    serverId,
    cwd,
    mode: diffMode,
    baseRef,
    ignoreWhitespace,
    queryScope,
  };
  const queryEnabled = enabled && isGit && !comparisonLoading;
  const {
    files,
    overviewFiles,
    overviewEntries,
    payloadError: diffPayloadError,
    diffTooLarge,
    isLoading: isDiffLoading,
  } = useWorkingDiffQueries({
    ...queryOptions,
    filePath,
    includeFileOverview,
    enabled: queryEnabled,
  });
  const treeFiles = useMemo(
    () => (overviewEntries ? diffEntryHeaders(overviewEntries) : overviewFiles),
    [overviewEntries, overviewFiles],
  );
  const reviewDraftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId,
        cwd,
        mode: diffMode,
        baseRef,
        ignoreWhitespace,
      }),
    [baseRef, cwd, diffMode, ignoreWhitespace, serverId, workspaceId],
  );
  const reviewActions = useInlineReviewController({ reviewDraftKey, presentation });
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd,
    mode: diffMode,
    baseRef,
  });

  const reviewFeedback = useReviewFeedback({
    serverId,
    workspaceId,
    reviewDraftKey,
    attachment: reviewAttachment,
  });

  return {
    status,
    isStatusLoading,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    currentBranchName,
    diffMode,
    selectUncommitted,
    selectBase,
    selectAll,
    files,
    overviewFiles,
    treeFiles,
    diffPayloadError,
    diffTooLarge,
    isDiffLoading: isDiffLoading || comparisonLoading,
    reviewActions,
    reviewAttachment,
    reviewFeedback,
  };
}

export function usePublishWorkingDiffAttachment({
  serverId,
  workspaceId,
  cwd,
  attachment,
  enabled,
}: {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  attachment: ReturnType<typeof useWorkingDiff>["reviewAttachment"];
  enabled: boolean;
}) {
  const scopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd }),
    [cwd, serverId, workspaceId],
  );
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const attachments = attachment ? [attachment] : [];
    setWorkspaceAttachments({ scopeKey, attachments });
    return () => {
      const current = useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey];
      if (current === attachments) {
        clearWorkspaceAttachments({ scopeKey });
      }
    };
  }, [attachment, clearWorkspaceAttachments, enabled, scopeKey, setWorkspaceAttachments]);
}
