import { forwardRef, useImperativeHandle, useMemo } from "react";
import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { useCanonicalPromptContext } from "@/timeline/use-canonical-prompt-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { ActualPromptRowsProvider } from "./actual-prompt-rows";
import { PromptDiscoverySurface } from "./prompt-navigation-surface";
import { PromptNavigationContext } from "./prompt-navigation-actions";
import { usePromptNavigationControls } from "./use-prompt-navigation-controls";
import {
  fetchReadingPromptContext,
  normalContextPageReader,
  type ContextPageReader,
} from "./fetch-reading-prompt-context";
import type { StreamItem } from "@/types/stream";
import { fetchPromptContent } from "./fetch-prompt-content";
import { useStickyPrompt } from "./use-sticky-prompt";
import { resolvePromptFeedback } from "./sticky-prompt-model";
import { useStreamTopOverlayInset } from "./top-overlay";

type Props = Parameters<typeof useStickyPrompt>[0] & {
  contextPageReader?: ContextPageReader | null;
  retainedContext?: Pick<
    ReturnType<typeof useCanonicalPromptContext>,
    "loading" | "error" | "exhausted" | "limited" | "cancelled" | "cancel" | "retry"
  >;
  serverId: string;
  agentId: string;
  client: DaemonClient | null;
  availableHeight: number;
  contentMaxWidth: number;
  children: ReactNode;
};

export interface StickyPromptHandle {
  followLatest(): void;
  reviewReading(): void;
}

/** Own navigation/disclosure; the viewport pins its actual loaded message row. */
export const StickyPrompt = forwardRef<StickyPromptHandle, Props>(function StickyPrompt(
  {
    serverId,
    agentId,
    client,
    contextPageReader,
    retainedContext,
    availableHeight,
    contentMaxWidth,
    children,
    ...input
  },
  ref,
) {
  const readPrompt = useStableEvent(async (seq: number) => {
    if (!client || !input.epoch) throw new Error("Prompt content is unavailable");
    return fetchPromptContent(client, agentId, input.epoch, seq);
  });
  const readContext = useStableEvent(async (source: StreamItem, signal: AbortSignal) => {
    if (!client || contextPageReader === null) throw new Error("Reading context is unavailable");
    return fetchReadingPromptContext(
      contextPageReader ?? normalContextPageReader(client, agentId),
      source,
      signal,
      contextPageReader ? "projected" : "canonical",
    );
  });
  const navigation = useStickyPrompt({
    ...input,
    contextManaged: retainedContext !== undefined,
    fetchPrompt: retainedContext ? undefined : readPrompt,
    fetchContext: retainedContext ? undefined : readContext,
  });
  const controls = usePromptNavigationControls(navigation);
  const feedback = resolvePromptFeedback(navigation, retainedContext);
  const retryContext = useStableEvent(() => {
    if (feedback.retryContext) retainedContext?.retry();
    else navigation.retry();
  });
  const cancelContext = useStableEvent(() => {
    retainedContext?.cancel();
    navigation.cancel();
  });
  const feedbackNavigation = useMemo(
    () => ({
      ...navigation,
      busy: feedback.busy,
      error: feedback.error,
      cancelled: feedback.cancelled,
      discoveryStatus: feedback.discoveryStatus,
      retry: retryContext,
      cancel: cancelContext,
    }),
    [
      navigation,
      feedback.busy,
      feedback.error,
      feedback.cancelled,
      feedback.discoveryStatus,
      retryContext,
      cancelContext,
    ],
  );

  useImperativeHandle(
    ref,
    () => ({
      followLatest: navigation.followLatest,
      reviewReading: navigation.reviewReading,
    }),
    [navigation.followLatest, navigation.reviewReading],
  );
  const rail = useMemo(
    () => ({ width: "100%" as const, maxWidth: contentMaxWidth }),
    [contentMaxWidth],
  );
  const topOverlayInset = useStreamTopOverlayInset();
  // Feedback sits outside the list, so it needs the floating header's clearance too.
  const feedbackStyle = useMemo(
    () => [styles.feedback, inlineUnistylesStyle({ top: topOverlayInset })],
    [topOverlayInset],
  );
  return (
    <ActualPromptRowsProvider
      enabled={input.enabled !== false}
      scope={`${serverId}:${agentId}:${input.epoch ?? "pending"}`}
      availableHeight={availableHeight}
    >
      <PromptNavigationContext.Provider value={input.enabled === false ? null : controls}>
        <View style={styles.timeline} testID="sticky-prompt-timeline">
          {children}
          {input.enabled !== false && (
            <View style={feedbackStyle} pointerEvents="box-none">
              <View style={rail} pointerEvents="box-none">
                <PromptDiscoverySurface navigation={feedbackNavigation} />
              </View>
            </View>
          )}
        </View>
      </PromptNavigationContext.Provider>
    </ActualPromptRowsProvider>
  );
});

const styles = StyleSheet.create({
  timeline: { flex: 1, minHeight: 0 },
  feedback: { position: "absolute", left: 0, right: 0, zIndex: 3, alignItems: "center" },
});
