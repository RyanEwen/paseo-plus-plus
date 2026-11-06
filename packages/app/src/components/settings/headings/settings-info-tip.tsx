import type { ComponentType, ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE, type Theme } from "@/styles/theme";

type TipIconComponent = ComponentType<{ size: number; color: string }>;

function TipIcon({ icon: Icon, color }: { icon: TipIconComponent; color: string }) {
  return <Icon size={ICON_SIZE.sm} color={color} />;
}

const ThemedTipIcon = withUnistyles(TipIcon);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SettingsInfoTipProps {
  /** Header the tip belongs to; used for the accessibility label. */
  title: string;
  info: ReactNode;
  /** Defaults to the info icon. */
  icon?: TipIconComponent;
  /** Defaults to "About {title}". */
  accessibilityLabel?: string;
  testID?: string;
  contentTestID?: string;
  /** Image help can use a wider frame while ordinary text tips keep the default. */
  contentMaxWidth?: number;
}

/**
 * The one way a settings group or section explains itself: an info icon on the
 * header that opens a tooltip. Never a paragraph under the header — see
 * docs/design.md §7. Rows use it the same way to keep secondary details on one line.
 */
export function SettingsInfoTip({
  title,
  info,
  testID,
  contentTestID,
  contentMaxWidth,
  icon = Info,
  accessibilityLabel,
}: SettingsInfoTipProps) {
  const { t } = useTranslation();
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? t("settings.groupInfo", { title })}
          testID={testID}
          hitSlop={8}
          style={styles.button}
        >
          <ThemedTipIcon icon={icon} uniProps={mutedIconMapping} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        offset={8}
        testID={contentTestID}
        maxWidth={contentMaxWidth}
      >
        {typeof info === "string" || typeof info === "number" ? (
          <Text style={styles.tooltipText}>{info}</Text>
        ) : (
          info
        )}
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    padding: theme.spacing[1],
    marginLeft: -theme.spacing[1],
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    maxWidth: 280,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
