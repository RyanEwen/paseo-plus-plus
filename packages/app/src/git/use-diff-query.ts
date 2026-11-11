import { useHostFeature } from "@/runtime/host-features";
import { useTranslation } from "react-i18next";
import { shareCheckoutDiff } from "./diff-sharing";
import { useSessionStore } from "@/stores/session-store";
import { useMemo } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useReplicaQuery } from "@/data/query";
import { checkoutDiffPushRoute } from "@/data/push-router";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  checkoutDiffComparisonError,
  deriveCheckoutDiffResult,
  type CheckoutDiffSnapshot,
} from "./diff-snapshot";
export { deriveCheckoutDiffResult } from "./diff-snapshot";
import type { DiffError, ParsedDiffFile } from "@getpaseo/protocol/messages";
import { checkoutDiffQueryKey } from "@/git/query-keys";

interface UseCheckoutDiffQueryOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base" | "all";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  enabled?: boolean;
  queryScope?: string;
  filePath?: string;
}

type CheckoutDiffQueryPayload = CheckoutDiffSnapshot;

// Re-export the canonical protocol type so all consumers share one definition.
export type { ParsedDiffFile };
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

function normalizeCheckoutDiffCompare(compare: {
  mode: "uncommitted" | "base" | "all";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  filePath?: string;
}) {
  const baseRef = compare.mode !== "uncommitted" ? compare.baseRef?.trim() : undefined;
  return {
    mode: compare.mode,
    ...(baseRef ? { baseRef } : {}),
    ignoreWhitespace: compare.ignoreWhitespace === true,
    ...(compare.filePath !== undefined ? { filePath: compare.filePath } : {}),
  };
}

export function useCheckoutDiffQuery({
  serverId,
  cwd,
  mode,
  baseRef,
  ignoreWhitespace,
  enabled = true,
  queryScope,
  filePath,
}: UseCheckoutDiffQueryOptions) {
  const unsupportedScopeError = useUnsupportedFileScopeError(serverId, filePath);
  // COMPAT(checkoutDiffAll): added in v0.12.0, remove after 2027-04-21 once host floor includes All changes.
  const allSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.checkoutDiffAll === true,
  );
  const requiresUpdate = mode === "all" && !allSupported;
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabled = enabled && retainedPanelActive;
  const isConnected = useHostRuntimeIsConnected(serverId);
  const normalizedCompare = useMemo(
    () => normalizeCheckoutDiffCompare({ mode, baseRef, ignoreWhitespace, filePath }),
    [mode, baseRef, ignoreWhitespace, filePath],
  );
  const compareMode = normalizedCompare.mode;
  const compareBaseRef = normalizedCompare.baseRef;
  const compareIgnoreWhitespace = normalizedCompare.ignoreWhitespace;
  const queryKey = useMemo(() => {
    const comparisonKey = checkoutDiffQueryKey(
      serverId,
      cwd,
      compareMode,
      compareBaseRef,
      compareIgnoreWhitespace,
      filePath,
    );
    const normalizedScope = queryScope?.trim();
    return normalizedScope ? [...comparisonKey, "scope", normalizedScope] : comparisonKey;
  }, [serverId, cwd, compareMode, compareBaseRef, compareIgnoreWhitespace, queryScope, filePath]);
  const subscriptionId = useMemo(() => `checkoutDiff:${JSON.stringify(queryKey)}`, [queryKey]);
  const comparisonError =
    queryEnabled && isConnected ? checkoutDiffComparisonError(normalizedCompare) : null;
  const routeEnabled = Boolean(
    queryEnabled &&
    isConnected &&
    cwd &&
    !unsupportedScopeError &&
    !requiresUpdate &&
    !comparisonError,
  );

  const query = useReplicaQuery<CheckoutDiffQueryPayload>({
    queryKey,
    structuralSharing: shareCheckoutDiff,
    enabled: routeEnabled,
    pushEvent: "checkout_diff_update",
    meta: checkoutDiffPushRoute({
      enabled: routeEnabled,
      serverId,
      subscriptionId,
      cwd,
      compare: {
        mode: compareMode,
        ...(compareBaseRef ? { baseRef: compareBaseRef } : {}),
        ignoreWhitespace: compareIgnoreWhitespace,
        ...fileScopeFields(filePath),
      },
    }),
  });

  const boundaryError =
    unsupportedScopeError ??
    (requiresUpdate && isConnected
      ? { code: "UNKNOWN" as const, message: "Update the host to view All changes" }
      : comparisonError);
  return deriveCheckoutDiffResult(
    boundaryError
      ? { requestId: "unavailable", cwd, files: [], error: boundaryError }
      : (query.data ?? null),
  );
}

/**
 * Fork: a single-file scope needs a host that reads one file's diff on its own budget. Returns
 * the update instruction to show instead of the diff when the host lacks that capability.
 */
function useUnsupportedFileScopeError(
  serverId: string,
  filePath: string | undefined,
): DiffError | null {
  const { t } = useTranslation();
  // COMPAT(checkoutFileDiff): added in v0.11.2, remove after 2027-10-16.
  const supportsFileDiff = useHostFeature(serverId, "checkoutFileDiff");
  if (filePath === undefined || supportsFileDiff) return null;
  return { code: "UNKNOWN", message: t("workspace.git.diff.updateHostFileDiff") };
}

/** Fork: the compare fields that limit a checkout diff route to one changed file, if any. */
function fileScopeFields(filePath: string | undefined): { filePath?: string } {
  return filePath === undefined ? {} : { filePath };
}
