import * as React from "react";
import { useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AgentCapabilityFlags } from "@getpaseo/protocol/agent-types";
import { RewindMenu } from "@/components/rewind/rewind-menu";
import { SPACING } from "@/styles/theme";
import { STREAM_METADATA_FONT_SIZE } from "../message-layout";
import { TurnCopyButton } from "../turn-copy-button";
import { NaturalMessageFlowContext } from "./flow";
import { trailingRailStyles } from "./measured-styles";

/** The action row under a prompt; on web it follows the measured natural rail. */
export function UserMessageTrailingRow({
  backed,
  backdrop,
  style,
  children,
  ...props
}: React.ComponentProps<typeof View> & { backed: boolean; backdrop: ReactNode }) {
  const flow = useContext(NaturalMessageFlowContext);
  const web = flow?.web === true;
  const railWidth = flow?.webRailWidth;
  const padding = backed ? SPACING[2] : 0;
  const rails = useMemo(() => trailingRailStyles({ railWidth, padding }), [railWidth, padding]);
  const paintStyle = useMemo<React.ComponentProps<typeof View>["style"]>(() => {
    if (!web) return [trailingRowStyles.trailingContent, style];
    return [style, rails.paint];
  }, [web, style, rails]);
  const contentStyle = useMemo<React.ComponentProps<typeof View>["style"]>(
    () => [trailingRowStyles.trailingContent, rails.content],
    [rails],
  );
  if (!web)
    return (
      <View {...props} style={paintStyle}>
        {backdrop}
        {children}
      </View>
    );
  return (
    <View {...props} style={paintStyle}>
      {backdrop}
      <View style={contentStyle} testID="user-message-action-content">
        {children}
      </View>
    </View>
  );
}

/** Keep timestamp, rewind and copy together beside optional prompt navigation. */
export function UserMessageTextActions({
  formattedTimestamp,
  capabilities,
  messageId,
  isRewindPending,
  message,
  onRewind,
  getContent,
}: {
  formattedTimestamp: string;
  capabilities?: AgentCapabilityFlags;
  messageId?: string;
  isRewindPending: boolean;
  message: string;
  onRewind: React.ComponentProps<typeof RewindMenu>["onRewind"];
  getContent: () => string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Text style={trailingRowStyles.timestampText} testID="user-message-timestamp">
        {formattedTimestamp}
      </Text>
      {capabilities && messageId ? (
        <RewindMenu
          capabilities={capabilities}
          isPending={isRewindPending}
          rewoundText={message}
          onRewind={onRewind}
        />
      ) : null}
      <TurnCopyButton
        getContent={getContent}
        containerStyle={trailingRowStyles.copyButton}
        accessibilityLabel={t("message.actions.copyMessage")}
      />
    </>
  );
}

const trailingRowStyles = StyleSheet.create((theme) => ({
  trailingContent: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 24,
    gap: theme.spacing[2],
  },
  timestampText: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
  },
  copyButton: {
    alignSelf: "center",
    padding: theme.spacing[1],
    paddingTop: theme.spacing[1],
    marginTop: 0,
    marginRight: -theme.spacing[1],
  },
}));
