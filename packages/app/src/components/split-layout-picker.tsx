import { PressHighlight } from "@/components/ui/press-highlight";
import { useMenuRowProps } from "@/components/ui/menu";
import { useCallback, useMemo } from "react";
import { View, Text, type PressableStateCallbackType } from "react-native";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SplitDirection, SplitSide } from "@/stores/workspace-layout-splits";
import { SPLIT_LAYOUT_PRESETS } from "./split-layout-presets";

/** Width of the picker grid; menus that host it use it as their minimum width. */
export const SPLIT_LAYOUT_PICKER_WIDTH = 280;

/** Diagram width along a compact row axis: a 220 px usable axis keeps a 20% region at 44 px. */
const COMPACT_DIAGRAM_LONG_AXIS = 222;
/** Diagram extent across a compact row, sized for a 44 px touch target. */
const COMPACT_DIAGRAM_SHORT_AXIS = 48;
/** Diagram width on a fine-pointer layout. */
const DIAGRAM_WIDTH = 48;
/** Diagram height on a fine-pointer layout. */
const DIAGRAM_HEIGHT = 28;
/** Border width on both ends of the diagram's split axis, outside the hit regions. */
const DIAGRAM_AXIS_INSET = 2;

type SplitPickerIntent = { kind: "open"; item: string } | { kind: "move" };
interface SplitLayoutPickerProps {
  onSelect: (side: SplitSide, firstPaneFraction: number) => void;
  intent: SplitPickerIntent;
  disabled?: boolean;
  testIDPrefix: string;
}

/**
 * Select the actual new-pane region; fractions always describe the left/top pane.
 *
 * @param props.compact Use touch-sized diagrams, from the caller's form factor.
 * @param props.blockedDirections Split directions greyed out at the depth limit.
 */
export function SplitLayoutPicker({
  compact,
  blockedDirections,
  ...props
}: SplitLayoutPickerProps & {
  compact: boolean;
  blockedDirections?: ReadonlySet<SplitDirection>;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.grid}>
      {(["horizontal", "vertical"] as const).map((direction) => (
        <View key={direction} style={styles.section}>
          <Text style={styles.label}>
            {t(direction === "horizontal" ? "workspace.splits.columns" : "workspace.splits.rows")}
          </Text>
          <View style={styles.row}>
            {SPLIT_LAYOUT_PRESETS.map((preset) => (
              <SplitDiagram
                key={preset.id}
                {...props}
                direction={direction}
                compact={compact}
                blocked={blockedDirections?.has(direction) ?? false}
                fraction={preset.fraction}
                label={preset.label}
                presetId={preset.id}
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Outer size of one diagram. Compact diagrams stretch along their split axis so the smallest
 * region still meets the touch minimum; the gap sits outside both hit regions, so adjacent
 * targets need no overlapping hitSlop.
 */
function resolveDiagramSize(input: { compact: boolean; horizontal: boolean }): {
  width: number;
  height: number;
} {
  if (!input.compact) {
    return { width: DIAGRAM_WIDTH, height: DIAGRAM_HEIGHT };
  }
  if (input.horizontal) {
    return { width: COMPACT_DIAGRAM_LONG_AXIS, height: COMPACT_DIAGRAM_SHORT_AXIS };
  }
  return { width: DIAGRAM_WIDTH, height: COMPACT_DIAGRAM_LONG_AXIS };
}

function SplitDiagram({
  direction,
  compact,
  fraction,
  label,
  presetId,
  ...props
}: SplitLayoutPickerProps & {
  direction: SplitDirection;
  compact: boolean;
  blocked: boolean;
  fraction: number;
  label: string;
  presetId: string;
}) {
  const horizontal = direction === "horizontal";
  const { width, height } = resolveDiagramSize({ compact, horizontal });
  const usableAxis = (horizontal ? width : height) - DIAGRAM_AXIS_INSET;
  const firstRegionSize = usableAxis * fraction;
  const secondRegionSize = usableAxis - firstRegionSize;
  const diagramStyle = useMemo(
    () => [
      styles.diagram,
      { width, height, flexDirection: horizontal ? ("row" as const) : ("column" as const) },
    ],
    [width, height, horizontal],
  );
  return (
    <View style={styles.choice}>
      <View style={diagramStyle}>
        <SplitRegion
          {...props}
          side={horizontal ? "left" : "top"}
          fraction={fraction}
          presetId={presetId}
          percent={Math.round(fraction * 100)}
          width={horizontal ? firstRegionSize : width}
          height={horizontal ? height : firstRegionSize}
        />
        <SplitRegion
          {...props}
          side={horizontal ? "right" : "bottom"}
          fraction={fraction}
          presetId={presetId}
          percent={Math.round((1 - fraction) * 100)}
          width={horizontal ? secondRegionSize : width}
          height={horizontal ? height : secondRegionSize}
        />
      </View>
      <Text style={styles.ratio}>{label}</Text>
    </View>
  );
}

function SplitRegion({
  side,
  fraction,
  percent,
  presetId,
  width,
  height,
  intent,
  onSelect,
  disabled = false,
  blocked,
  testIDPrefix,
}: SplitLayoutPickerProps & {
  blocked: boolean;
  side: SplitSide;
  fraction: number;
  percent: number;
  presetId: string;
  width: number;
  height: number;
}) {
  const { t } = useTranslation();
  // Menu callers own selectItem so closing and the iOS teardown grace run once.
  // A blocked region stays pressable to the platform so hover and tap can explain it.
  const inert = disabled || blocked;
  const select = useCallback(() => {
    if (!inert) {
      onSelect(side, fraction);
    }
  }, [inert, onSelect, side, fraction]);
  const rowProps = useMenuRowProps({ disabled: inert });
  const accessibilityState = useMemo(() => ({ disabled: inert }), [inert]);
  const regionStyle = useCallback(
    ({
      pressed,
      hovered = false,
      focused = false,
    }: PressableStateCallbackType & { hovered?: boolean; focused?: boolean }) => [
      styles.region,
      { width, height },
      !inert && (pressed || hovered || focused) ? styles.highlighted : null,
      inert ? styles.disabled : null,
    ],
    [inert, width, height],
  );
  const sideLabel = t(`workspace.splits.${side}`);
  const regionLabel =
    intent.kind === "open"
      ? t("workspace.splits.openRegion", { item: intent.item, side: sideLabel, percent })
      : t("workspace.splits.moveRegion", { side: sideLabel, percent });
  const blockedReason = blocked ? t("workspace.splits.maxDepthReached") : null;
  const accessibilityLabel = blockedReason ? `${regionLabel}. ${blockedReason}` : regionLabel;
  const region = (
    <PressHighlight
      highlightStyle={styles.highlighted}
      style={regionStyle}
      disabled={disabled}
      onPress={select}
      {...rowProps}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      testID={`${testIDPrefix}-${side}-${presetId}`}
    />
  );
  if (!blockedReason) {
    return region;
  }
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>{region}</TooltipTrigger>
      <TooltipContent side="top" align="center" offset={6}>
        <Text style={styles.tooltipText}>{blockedReason}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  grid: { width: SPLIT_LAYOUT_PICKER_WIDTH, padding: theme.spacing[2], gap: theme.spacing[2] },
  section: { gap: theme.spacing[1] },
  label: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1], alignItems: "flex-start" },
  choice: { alignItems: "center", gap: theme.spacing[1] },
  // Physical left/right stay literal even when the surrounding language is RTL.
  diagram: { direction: "ltr", gap: theme.spacing[0.5] },
  region: {
    flexShrink: 0,
    borderWidth: 1,
    borderRadius: theme.borderRadius.sm,
    borderColor: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface1,
  },
  highlighted: { backgroundColor: theme.colors.surface3, borderColor: theme.colors.accent },
  disabled: { opacity: theme.opacity[50] },
  tooltipText: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  ratio: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, direction: "ltr" },
}));
