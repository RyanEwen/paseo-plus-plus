import { SplitLayoutPicker } from "@/components/split-layout-picker";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  MenuItem,
  MenuSubTrigger,
  useMenuContext,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSplitLayoutControlsEnabled } from "@/paseo-plus-plus/split-layout-controls";
import {
  collectAllPanes,
  findPaneContainingTab,
  type SplitNode,
} from "@/stores/workspace-layout-actions";
import type { SplitSide } from "@/stores/workspace-layout-splits";

interface SplitMenuOwner {
  root: SplitNode | null;
  enabled: boolean;
  onMove: (tabId: string, paneId: string) => void;
  onSplit: (input: {
    tabId: string;
    targetPaneId: string;
    position: SplitSide;
    firstPaneFraction?: number;
  }) => void;
}
const SplitMenuContext = createContext<SplitMenuOwner | null>(null);
const MOVE_INTENT = { kind: "move" } as const;

export interface WorkspaceTabSplitMenu {
  trigger: ReactNode;
  pages: MenuPageDefinition[];
}
const EMPTY_SPLIT_MENU: WorkspaceTabSplitMenu = { trigger: null, pages: [] };

/**
 * Keep tab movement bound to the pane tree that owns the menu, including portalled menus.
 *
 * @param props.root Main split tree. Moving needs its structure only, so callers pass a tree
 *   that does not change on divider commits.
 */
export function WorkspaceSplitMenuScope({
  children,
  root,
  enabled,
  onMove,
  onSplit,
}: SplitMenuOwner & { children: ReactNode }) {
  const controlsEnabled = useSplitLayoutControlsEnabled();
  const value = useMemo(
    () => ({
      root,
      onMove,
      onSplit,
      enabled: enabled && controlsEnabled,
    }),
    [root, onMove, onSplit, enabled, controlsEnabled],
  );
  return <SplitMenuContext.Provider value={value}>{children}</SplitMenuContext.Provider>;
}

/** The visible pane holding this tab when the owning scope allows moving it, otherwise null. */
function resolveMovableSourcePaneId(owner: SplitMenuOwner | null, tabId: string): string | null {
  if (!owner?.enabled || !owner.root) {
    return null;
  }
  const source = findPaneContainingTab(owner.root, tabId);
  if (!source || source.hidden) {
    return null;
  }
  return source.id;
}

/**
 * Move the same tab to an existing pane or a new side split; content and close lifecycles stay
 * untouched. Rows only resolve the source pane; the page builds its pane list when it opens.
 */
export function useWorkspaceTabSplitMenu(tabId: string): WorkspaceTabSplitMenu {
  const owner = useContext(SplitMenuContext);
  const { t } = useTranslation();
  const sourcePaneId = resolveMovableSourcePaneId(owner, tabId);
  return useMemo(() => {
    if (!sourcePaneId) {
      return EMPTY_SPLIT_MENU;
    }
    const id = `workspace-tab-move-${tabId}`;
    return {
      trigger: (
        <MenuSubTrigger id={id} testID={id}>
          {t("workspace.splits.moveTab")}
        </MenuSubTrigger>
      ),
      pages: [
        {
          id,
          title: t("workspace.splits.moveTab"),
          hoverIntent: false,
          content: <MoveTabPage tabId={tabId} sourcePaneId={sourcePaneId} menuId={id} />,
        },
      ],
    };
  }, [sourcePaneId, tabId, t]);
}

/** Existing destination panes plus the region picker, built only while the page is open. */
function MoveTabPage({
  tabId,
  sourcePaneId,
  menuId,
}: {
  tabId: string;
  sourcePaneId: string;
  menuId: string;
}) {
  const owner = useContext(SplitMenuContext);
  const { t } = useTranslation();
  const root = owner?.root ?? null;
  const panes = useMemo(
    () => (root ? collectAllPanes(root).filter((pane) => !pane.hidden) : []),
    [root],
  );
  if (!owner) {
    return null;
  }
  return (
    <>
      {panes.map((pane, index) =>
        pane.id !== sourcePaneId ? (
          <MovePaneMenuItem
            key={pane.id}
            owner={owner}
            tabId={tabId}
            paneId={pane.id}
            label={t("workspace.splits.pane", { index: index + 1 })}
            menuId={menuId}
          />
        ) : null,
      )}
      <MoveSplitPicker owner={owner} tabId={tabId} targetPaneId={sourcePaneId} menuId={menuId} />
    </>
  );
}

function MoveSplitPicker({
  owner,
  tabId,
  targetPaneId,
  menuId,
}: {
  owner: SplitMenuOwner;
  tabId: string;
  targetPaneId: string;
  menuId: string;
}) {
  const menu = useMenuContext("MoveSplitPicker");
  const compact = useIsCompactFormFactor();
  const select = useCallback(
    (position: SplitSide, firstPaneFraction: number) =>
      menu.selectItem(
        () => owner.onSplit({ tabId, targetPaneId, position, firstPaneFraction }),
        true,
      ),
    [owner, tabId, targetPaneId, menu],
  );
  return (
    <SplitLayoutPicker
      intent={MOVE_INTENT}
      onSelect={select}
      compact={compact}
      testIDPrefix={menuId}
    />
  );
}

function MovePaneMenuItem({
  owner,
  tabId,
  paneId,
  label,
  menuId,
}: {
  owner: SplitMenuOwner;
  tabId: string;
  paneId: string;
  label: string;
  menuId: string;
}) {
  const select = useCallback(() => owner.onMove(tabId, paneId), [owner, tabId, paneId]);
  return (
    <MenuItem testID={`${menuId}-pane-${paneId}`} onSelect={select}>
      {label}
    </MenuItem>
  );
}
