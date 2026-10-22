import { useCallback, useState } from "react";
import { Text, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { ZoomIn } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getBrowserWebviewZoom, setBrowserWebviewZoom } from "../resident-webviews";
import { ToolbarMenuContent, useToolbarMenuTriggerStyle } from "./toolbar-menu-trigger.electron";

const ZOOM_FACTORS = [0.25, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const ThemedZoom = withUnistyles(ZoomIn);
const mutedIcon = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

/** Use native guest zoom rather than the host window's application-wide zoom shortcuts. */
export function PageZoomMenu({
  browserId,
  getWebview,
  triggerStyle,
  tooltipTextStyle,
}: {
  browserId: string;
  getWebview: () => HTMLElement | null;
  triggerStyle: (state: { hovered?: boolean; pressed?: boolean }) => StyleProp<ViewStyle>;
  tooltipTextStyle: StyleProp<TextStyle>;
}) {
  const { t } = useTranslation();
  const menuTriggerStyle = useToolbarMenuTriggerStyle(triggerStyle);
  const [zoom, setZoom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const handleOpen = useCallback(
    (open: boolean) => {
      if (!open) return;
      setZoom(getBrowserWebviewZoom(getWebview()));
      setFailed(false);
    },
    [getWebview],
  );
  const handleSelect = useCallback(
    (factor: number) => {
      const success = setBrowserWebviewZoom(browserId, factor);
      setFailed(!success);
      setZoom(getBrowserWebviewZoom(getWebview()));
    },
    [browserId, getWebview],
  );
  const label = t("workspace.browser.controls.pageZoom");
  return (
    <DropdownMenu onOpenChange={handleOpen}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            accessibilityRole="button"
            accessibilityLabel={label}
            style={menuTriggerStyle}
          >
            <ToolbarMenuContent>
              <ThemedZoom size={16} uniProps={mutedIcon} />
            </ToolbarMenuContent>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={tooltipTextStyle}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" scrollable maxHeight={360}>
        {failed ? (
          <DropdownMenuItem disabled>{t("workspace.browser.controls.zoomFailed")}</DropdownMenuItem>
        ) : null}
        {ZOOM_FACTORS.map((factor) => (
          <PageZoomItem
            key={factor}
            factor={factor}
            selected={zoom !== null && Math.abs(zoom - factor) < 0.001}
            disabled={zoom === null}
            onSelect={handleSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PageZoomItem({
  factor,
  selected,
  disabled,
  onSelect,
}: {
  factor: number;
  selected: boolean;
  disabled: boolean;
  onSelect: (factor: number) => void;
}) {
  const select = useCallback(() => onSelect(factor), [onSelect, factor]);
  return (
    <DropdownMenuItem
      onSelect={select}
      selected={selected}
      showSelectedCheck
      disabled={disabled}
      closeOnSelect={false}
    >
      {`${Math.round(factor * 100)}%`}
    </DropdownMenuItem>
  );
}
