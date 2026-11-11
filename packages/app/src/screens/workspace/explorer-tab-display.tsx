import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { controlHeightForLayout } from "@/components/ui/control-geometry";
import { isNative } from "@/constants/platform";
import { useSettingsSave } from "@/hooks/use-settings/use-settings-save";
import type { PaneHost } from "@/panels/panel-manifest";

/** Matches the workspace tab context menu width. */
const STRIP_MENU_WIDTH = 220;

export interface ExplorerTabDisplayControl {
  enabled: boolean;
  disabled: boolean;
  pending: boolean;
  failed: boolean;
  toggle(): void;
}

/**
 * The square cell width for icon-only tabs.
 *
 * On wide layouts it matches the strip's new-tab control and the tab height (`sm`: 28 points with
 * a pointer, 32 on a touch screen). Compact layouts use the 44-point `md` touch height instead, so
 * the cell stays an easy touch target even though the new-tab control beside it is smaller.
 */
export function iconOnlyTabWidth(compact: boolean): number {
  if (compact) {
    return controlHeightForLayout("md", true);
  }
  return controlHeightForLayout("sm", false);
}

/**
 * The checked Icon-only tabs row, for a tab's context menu or the empty strip's menu.
 *
 * The control arrives as a prop, never through React context: on compact layouts the menu renders
 * in a bottom sheet portal that only carries the menu's own contexts, so a provider around the
 * tab row would be invisible here. Renders nothing for a null control (outside the Explorer).
 */
export function ExplorerIconOnlyMenuItem({
  control,
}: {
  control: ExplorerTabDisplayControl | null;
}) {
  const { t } = useTranslation();
  if (!control) return null;
  return (
    <ContextMenuItem
      selected={control.enabled}
      showSelectedCheck
      disabled={control.disabled}
      status={control.pending ? "pending" : "idle"}
      description={control.failed ? t("paseoPlusPlus.saveFailed") : undefined}
      closeOnSelect={false}
      onSelect={control.toggle}
      testID="explorer-icon-only-tabs-menu-item"
    >
      {t("explorerTabs.iconOnlyLabel")}
    </ContextMenuItem>
  );
}

/**
 * The Explorer's icon-only display state and toggle for a tab row in `host`.
 *
 * Returns null outside the Explorer, so callers render no toggle there. The preference is
 * device-local, so only this device's settings loading disables the toggle.
 */
export function useExplorerTabDisplay(host: PaneHost): ExplorerTabDisplayControl | null {
  const { settings, save, pending, failed, isLoading, error } =
    useSettingsSave<"explorerIconOnlyTabs">();
  const enabled = settings.paseoPlusPlus.explorerIconOnlyTabs;
  const toggle = useCallback(() => {
    void save("explorerIconOnlyTabs", (current) => ({
      paseoPlusPlus: {
        ...current.paseoPlusPlus,
        explorerIconOnlyTabs: !current.paseoPlusPlus.explorerIconOnlyTabs,
      },
    }));
  }, [save]);
  const control = useMemo<ExplorerTabDisplayControl>(
    () => ({
      enabled,
      disabled: isLoading || error !== null || pending !== null,
      pending: pending !== null,
      failed: failed !== null,
      toggle,
    }),
    [enabled, isLoading, error, pending, failed, toggle],
  );
  return host === "explorer" ? control : null;
}

/**
 * Adds the Icon-only tabs toggle to a right-click on the empty Explorer strip (pointer layouts
 * only). Renders `children` unchanged for a null control and on native, where the strip menu cannot
 * open: there the trigger's `flex: 1` wrapper collapses to zero height inside the rail, and the tab
 * strip would overflow under the Explorer panel's divider and content.
 */
export function ExplorerTabStripContextMenu({
  control,
  children,
}: {
  control: ExplorerTabDisplayControl | null;
  children: ReactNode;
}) {
  if (!control || isNative) return children;
  return (
    <ContextMenu>
      <ContextMenuTrigger contextOnly enabledOnMobile={false} style={styles.stripContextHost}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent width={STRIP_MENU_WIDTH} testID="explorer-tab-strip-menu">
        <ExplorerIconOnlyMenuItem control={control} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const styles = StyleSheet.create({
  stripContextHost: { flex: 1, minWidth: 0 },
});

/** Square, label-less tab cells; applied alongside the tab row's own chip and handle styles. */
export const iconOnlyTabStyles = StyleSheet.create({
  tab: { paddingHorizontal: 0, justifyContent: "center" },
  handle: { justifyContent: "center", gap: 0 },
});
