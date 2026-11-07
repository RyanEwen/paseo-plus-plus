import { SplitLayoutGlyph } from "./split-layout-glyph";
import { useMemo, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { useSplitLayoutControlsEnabled } from "@/paseo-plus-plus/split-layout-controls";
import {
  applySplitLayoutPreset,
  canApplySplitLayoutPreset,
  SPLIT_LAYOUT_PRESETS,
} from "./split-layout-presets";

/** Share difference within which a preset is shown as the divider's current ratio. */
const CURRENT_PRESET_TOLERANCE = 0.001;

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
  const controlsEnabled = useSplitLayoutControlsEnabled();
  const available = enabled && controlsEnabled;
  const choices = useMemo(() => {
    const first = sizes[index] ?? 0;
    const pair = first + (sizes[index + 1] ?? 0);
    return SPLIT_LAYOUT_PRESETS.map((preset) => {
      const nextSizes = applySplitLayoutPreset(sizes, index, preset.fraction);
      const fitsDivider = canApplySplitLayoutPreset(sizes, index, preset.fraction);
      const fitsCaller = canApplyPreset?.(nextSizes) ?? true;
      const allowed = fitsDivider && fitsCaller;
      return {
        id: preset.id,
        label: preset.label,
        fraction: preset.fraction,
        icon: <SplitLayoutGlyph direction={direction} fraction={preset.fraction} />,
        available: allowed,
        isCurrent: Math.abs(first - pair * preset.fraction) < CURRENT_PRESET_TOLERANCE,
        select: () => {
          // Custom dock limits must guard execution as well as the disabled control.
          if (allowed) {
            onSelect(nextSizes);
          }
        },
      };
    });
  }, [sizes, index, onSelect, direction, canApplyPreset]);
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
              key={preset.id}
              variant={preset.isCurrent ? "secondary" : "ghost"}
              size="md"
              style={styles.choice}
              textStyle={styles.ratio}
              leftIcon={preset.icon}
              disabled={!preset.available}
              accessibilityLabel={t("workspace.splits.ratio", { ratio: preset.label })}
              testID={`workspace-split-preset-${preset.id}`}
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
