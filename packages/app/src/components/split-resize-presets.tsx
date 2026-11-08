import { SplitLayoutGlyph } from "./split-layout-glyph";
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  Text,
  View,
  type PressableStateCallbackType,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { createControlGeometry } from "@/components/ui/control-geometry";
import { PressHighlight } from "@/components/ui/press-highlight";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { useSplitLayoutControlsEnabled } from "@/paseo-plus-plus/split-layout-controls";
import {
  applySplitLayoutPreset,
  canApplySplitLayoutPreset,
  SPLIT_LAYOUT_PRESETS,
} from "./split-layout-presets";

interface RatioPresetChoice {
  id: string;
  label: string;
  icon: ReactElement;
  available: boolean;
  isCurrent: boolean;
  select: () => void;
}

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
            <RatioPresetTile key={preset.id} preset={preset} />
          ))}
        </View>
      </HoverCardContent>
    </HoverCard>
  );
}

/** One ratio as an icon over its label; the divider's current ratio is filled. */
function RatioPresetTile({ preset }: { preset: RatioPresetChoice }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const disabled = !preset.available;
  const { isCurrent } = preset;
  const tileStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.tile,
      isCurrent ? styles.tileCurrent : null,
      pressed ? styles.tilePressed : null,
      disabled ? styles.tileDisabled : null,
    ],
    [isCurrent, disabled],
  );
  const ratioStyle = useMemo(
    () => [styles.ratio, isCurrent || hovered ? null : styles.ratioMuted],
    [isCurrent, hovered],
  );
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("workspace.splits.ratio", { ratio: preset.label })}
      accessibilityState={accessibilityState}
      disabled={disabled}
      highlightStyle={styles.tilePressed}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      onPress={preset.select}
      style={tileStyle}
      testID={`workspace-split-preset-${preset.id}`}
    >
      <View>{preset.icon}</View>
      <Text style={ratioStyle}>{preset.label}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    tile: {
      ...geometry.buttonMd,
      width: 52,
      minHeight: 58,
      alignItems: "center",
      justifyContent: "center",
      gap: theme.spacing[0.5],
      paddingHorizontal: theme.spacing[0.5],
      borderWidth: 1,
      borderColor: "transparent",
    },
    tileCurrent: {
      backgroundColor: theme.colors.surface3,
      borderColor: theme.colors.surface3,
    },
    tilePressed: { opacity: 0.85 },
    tileDisabled: { opacity: theme.opacity[50] },
    ratio: {
      ...geometry.buttonTextMd,
      color: theme.colors.foreground,
      fontWeight: theme.fontWeight.medium,
      fontSize: theme.fontSize.sm,
    },
    ratioMuted: { color: theme.colors.foregroundMuted },
    presets: { flexDirection: "row", padding: theme.spacing[1], gap: theme.spacing[1] },
  };
});
