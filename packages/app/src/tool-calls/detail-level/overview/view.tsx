import React, { memo, useCallback, useMemo, useRef, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { IndentRail } from "@/components/indent-rail";
import { ExpandableBadge } from "@/components/message";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useReadableToolActivity } from "@/tool-calls/use-readable-tool-activity";
import { useOverviewSummaryLabel } from "./label";
import { buildOverviewGroup, type OverviewToolCallGroup } from "./model";
import { OverviewToolCallGroupSheet } from "./sheet";

interface OverviewGroupProps {
  group: OverviewToolCallGroup;
  expanded: boolean;
  isLastInSequence: boolean;
  onExpandedChange: (groupId: string, expanded: boolean) => void;
  children: ReactNode;
}

const TOOL_CALL_GROUP_MAX_HEIGHT = 400;

export const OverviewToolCallGroupView = memo(function OverviewToolCallGroupView({
  group,
  expanded,
  isLastInSequence,
  onExpandedChange,
  children,
}: OverviewGroupProps) {
  const scrollRef = useRef<ScrollView>(null);
  const isCompact = useIsCompactFormFactor();
  const descriptive = useReadableToolActivity();
  const summary = useMemo(
    () =>
      descriptive ? buildOverviewGroup(group.run, { descriptive: true }).summary : group.summary,
    [group.run, group.summary, descriptive],
  );
  const aggregateSummary = useOverviewSummaryLabel(summary, undefined, descriptive);
  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  const toggle = useCallback(() => {
    onExpandedChange(group.run.id, !expanded);
  }, [expanded, group.run.id, onExpandedChange]);
  const close = useCallback(() => {
    onExpandedChange(group.run.id, false);
  }, [group.run.id, onExpandedChange]);
  const renderDetails = useCallback(
    () => (
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        onContentSizeChange={scrollToLatest}
      >
        <IndentRail>{children}</IndentRail>
      </ScrollView>
    ),
    [children, scrollToLatest],
  );

  if (isCompact) {
    return (
      <>
        <ExpandableBadge
          testID="tool-call-group"
          label={aggregateSummary}
          icon={Wrench}
          isLoading={group.isLoading}
          isExpanded={false}
          isLastInSequence={isLastInSequence}
          onToggle={toggle}
        />
        <OverviewToolCallGroupSheet visible={expanded} summary={aggregateSummary} onClose={close}>
          {children}
        </OverviewToolCallGroupSheet>
      </>
    );
  }

  return (
    <ExpandableBadge
      testID="tool-call-group"
      label={aggregateSummary}
      icon={Wrench}
      isLoading={group.isLoading}
      isExpanded={expanded}
      isLastInSequence={isLastInSequence}
      onToggle={toggle}
      renderDetails={renderDetails}
      borderlessWhenExpanded
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  scroll: {
    maxHeight: TOOL_CALL_GROUP_MAX_HEIGHT,
  },
  content: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: 13,
  },
}));
