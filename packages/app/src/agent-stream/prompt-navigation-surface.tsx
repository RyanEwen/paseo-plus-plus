import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { useStickyPrompt } from "./use-sticky-prompt";

/** Keep discovery usable before a full prompt exists; an empty exhausted chat has no controls. */
export function PromptDiscoverySurface({
  navigation,
}: {
  navigation: ReturnType<typeof useStickyPrompt>;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const status = navigation.discoveryStatus;
  // Actual message rows own pinning. Never replace one with a passive spinner;
  // explicit navigation failures remain actionable beside the existing message.
  if (navigation.message && !navigation.error && status !== "limited") return null;
  if (
    !navigation.busy &&
    !navigation.error &&
    !(navigation.cancelled && !navigation.message) &&
    status !== "limited" &&
    status !== "exhausted"
  )
    return null;
  const label = t(resolvePromptDiscoveryLabel(navigation));
  return (
    <View style={styles.container} testID="sticky-user-message">
      <View style={styles.discoveryMessage} testID="sticky-prompt-system-feedback">
        <View style={styles.preview}>
          <Text
            style={styles.systemText}
            accessibilityRole={navigation.error ? "alert" : undefined}
            accessibilityLiveRegion="polite"
          >
            {label}
          </Text>
        </View>
        {navigation.busy && (
          <Button variant="ghost" size={size} onPress={navigation.cancel}>
            {t("common.actions.cancel")}
          </Button>
        )}
        {(navigation.error ||
          (navigation.cancelled && !navigation.message) ||
          status === "limited") && (
          <Button variant="ghost" size={size} onPress={navigation.retry}>
            {t("common.actions.retry")}
          </Button>
        )}
      </View>
    </View>
  );
}

/** Keep failure and cancellation copy ahead of bounded/exhausted discovery. */
function resolvePromptDiscoveryLabel(
  navigation: Pick<
    ReturnType<typeof useStickyPrompt>,
    "error" | "cancelled" | "message" | "discoveryStatus"
  >,
):
  | "common.loading"
  | "stickyPrompt.failed"
  | "stickyPrompt.cancelled"
  | "stickyPrompt.moreHistory"
  | "stickyPrompt.none" {
  if (navigation.error) return "stickyPrompt.failed";
  if (navigation.cancelled && !navigation.message) return "stickyPrompt.cancelled";
  if (navigation.discoveryStatus === "limited") return "stickyPrompt.moreHistory";
  if (navigation.discoveryStatus === "exhausted") return "stickyPrompt.none";
  return "common.loading";
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexShrink: 0,
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  discoveryMessage: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  preview: { flex: 1, minWidth: 0 },
  systemText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
