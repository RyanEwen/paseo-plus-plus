import { SplitPresetGlyph } from "./split-layout-glyph";
import { useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { useSettings } from "@/hooks/use-settings";
import {
  applySplitLayoutPreset,
  canApplySplitLayoutPreset,
  SPLIT_LAYOUT_PRESETS,
} from "./split-layout-presets";

/** Add a keyboard-accessible hover picker without changing the divider's drag gesture or identity. */
export function SplitResizePresets({
  children,
  style,
  enabled,
  dragging,
  direction,
  sizes,
  index,
  onSelect,
  canApplyPreset,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
  enabled: boolean;
  dragging: boolean;
  direction: "horizontal" | "vertical";
  sizes: number[];
  index: number;
  onSelect: (sizes: number[]) => void;
  canApplyPreset?: (sizes: number[]) => boolean;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const available = enabled && settings.paseoPlusPlus.splitLayoutPresets;
  const choices = useMemo(
    () =>
      SPLIT_LAYOUT_PRESETS.map((preset) => {
        const nextSizes = applySplitLayoutPreset(sizes, index, preset.fraction);
        const allowed =
          canApplySplitLayoutPreset(sizes, index, preset.fraction) &&
          (canApplyPreset?.(nextSizes) ?? true);
        return {
          label: preset.label,
          fraction: preset.fraction,
          icon: <SplitPresetGlyph direction={direction} fraction={preset.fraction} />,
          available: allowed,
          select: () => {
            // Custom dock limits must guard execution as well as the disabled control.
            if (allowed) onSelect(nextSizes);
          },
        };
      }),
    [sizes, index, onSelect, direction, canApplyPreset],
  );
  const pair = (sizes[index] ?? 0) + (sizes[index + 1] ?? 0);
  return (
    <HoverCard disabled={!available || dragging}>
      <HoverCardTrigger
        style={style}
        focusable={available}
        accessibilityLabel={t("workspace.splits.chooseRatio")}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        anchor="cursor"
        placement="bottom"
        testID="workspace-split-presets"
        accessibilityLabel={t("workspace.splits.chooseRatio")}
      >
        <View style={styles.presets}>
          {choices.map((preset) => (
            <Button
              key={preset.label}
              variant={
                Math.abs((sizes[index] ?? 0) - pair * preset.fraction) < 0.001
                  ? "secondary"
                  : "ghost"
              }
              size="md"
              style={styles.choice}
              textStyle={styles.ratio}
              leftIcon={preset.icon}
              disabled={!preset.available}
              accessibilityLabel={t("workspace.splits.ratio", { ratio: preset.label })}
              testID={`workspace-split-preset-${preset.label.replace("/", "-")}`}
              onPress={preset.select}
            >
              {preset.label}
            </Button>
          ))}
        </View>
      </HoverCardContent>
    </HoverCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  choice: {
    width: 52,
    minHeight: 58,
    flexDirection: "column",
    gap: theme.spacing[0.5],
    paddingHorizontal: theme.spacing[0.5],
  },
  ratio: { fontSize: theme.fontSize.sm },
  presets: { flexDirection: "row", padding: theme.spacing[1], gap: theme.spacing[1] },
}));
