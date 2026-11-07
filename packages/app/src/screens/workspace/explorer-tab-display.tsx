import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
const ExplorerTabDisplayContext = createContext<ExplorerTabDisplayControl | null>(null);

export function ExplorerIconOnlyMenuItem({ separator = false }: { separator?: boolean }) {
  const control = useContext(ExplorerTabDisplayContext);
  const { t } = useTranslation();
  if (!control) return null;
  return (
    <>
      {separator ? <ContextMenuSeparator /> : null}
      <ContextMenuItem
        selected={control.enabled}
        showSelectedCheck
        disabled={control.disabled}
        status={control.pending ? "pending" : "idle"}
        tooltip={control.failed ? t("paseoPlusPlus.saveFailed") : undefined}
        closeOnSelect={false}
        onSelect={control.toggle}
        testID="explorer-icon-only-tabs-menu-item"
      >
        {t("explorerTabs.iconOnlyLabel")}
      </ContextMenuItem>
    </>
  );
}

export function useExplorerTabDisplay(host: PaneHost): ExplorerTabDisplayControl {
  const { settings, save, pending, failed, isLoading, error } =
    useSettingsSave<"explorerIconOnlyTabs">();
  const iconOnly = host === "explorer" && settings.paseoPlusPlus.explorerIconOnlyTabs;
  const toggleIconOnly = useCallback(() => {
    void save("explorerIconOnlyTabs", (current) => ({
      paseoPlusPlus: {
        ...current.paseoPlusPlus,
        explorerIconOnlyTabs: !current.paseoPlusPlus.explorerIconOnlyTabs,
      },
    }));
  }, [save]);
  return useMemo<ExplorerTabDisplayControl>(
    () => ({
      enabled: iconOnly,
      disabled: isLoading || error !== null || pending !== null,
      pending: pending !== null,
      failed: failed !== null,
      toggle: toggleIconOnly,
    }),
    [iconOnly, isLoading, error, pending, failed, toggleIconOnly],
  );
}

export function ExplorerTabStripContextMenu({
  host,
  control,
  children,
}: {
  host: PaneHost;
  control: ExplorerTabDisplayControl;
  children: ReactNode;
}) {
  if (host !== "explorer") return children;
  return (
    <ExplorerTabDisplayContext.Provider value={control}>
      <ContextMenu>
        <ContextMenuTrigger contextOnly enabledOnMobile={false} style={styles.stripContextHost}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent width={STRIP_MENU_WIDTH} testID="explorer-tab-strip-menu">
          <ExplorerIconOnlyMenuItem />
        </ContextMenuContent>
      </ContextMenu>
    </ExplorerTabDisplayContext.Provider>
  );
}

const styles = StyleSheet.create({
  stripContextHost: { flex: 1, minWidth: 0 },
});

/** Square, label-less tab cells; applied alongside the tab row's own chip and handle styles. */
export const iconOnlyTabStyles = StyleSheet.create({
  tab: { paddingHorizontal: 0, justifyContent: "center" },
  handle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    minWidth: 0,
  },
});
