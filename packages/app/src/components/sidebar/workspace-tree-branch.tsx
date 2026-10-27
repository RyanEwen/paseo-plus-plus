import { useCallback, useMemo, type ReactElement, type MutableRefObject } from "react";
import { Text, View } from "react-native";
import type { GestureType } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { isDragGroupOrderValid } from "@/components/drag-reorder/reorder-items";
import { PressHighlight } from "@/components/ui/press-highlight";
import { TreeChevron, TREE_INDENT_PER_LEVEL } from "@/components/tree-primitives";
import { density } from "@/styles/density";
import { isNative } from "@/constants/platform";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useWorkspaceFamilyDrag } from "./use-workspace-family-drag";
import type { DragReorderMove } from "@/components/drag-reorder/reorder-items";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";
import { useSidebarWorkspaceTree } from "./workspace-tree-context";
import { summarizeWorkspaceChildren, workspaceCollapseKey } from "./workspace-tree";
import { resolveSidebarWorkspacePrimaryLabel } from "./sidebar-workspace-title";

interface WorkspaceTreeBranchProps<T extends SidebarWorkspacePlacement> {
  row: DraggableRenderItemInfo<T>;
  itemsByKey: ReadonlyMap<string, T>;
  renderRow: (row: DraggableRenderItemInfo<T>) => ReactElement;
  onSiblingReorder: (rows: T[]) => void;
  getDragGroupKey?: (workspace: T) => string | null;
  manualPins?: boolean;
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
  dragGestureHostActive?: boolean;
}

/**
 * A drag cell owns its whole family. Nested lists reorder siblings only, so dragging can never
 * change authoritative parentage or strand descendants in a different status/pin section.
 */
export function WorkspaceTreeBranch<T extends SidebarWorkspacePlacement>(
  props: WorkspaceTreeBranchProps<T>,
) {
  const {
    row,
    itemsByKey,
    renderRow,
    onSiblingReorder,
    getDragGroupKey,
    manualPins = false,
    parentGestureRef,
    dragGestureHostActive,
  } = props;
  const model = useSidebarWorkspaceTree();
  const workspaceTitleSource = useSidebarViewStore((state) => state.workspaceTitleSource);
  const { t } = useTranslation();
  const key = row.item.workspaceKey;
  const node = model.tree.get(key);
  const collapsed = model.collapsedKeys.has(workspaceCollapseKey(key));
  const childKeys = node?.childKeys;
  const children = useMemo(
    () =>
      (childKeys ?? []).flatMap((child) => {
        const workspace = itemsByKey.get(child);
        return workspace ? [workspace] : [];
      }),
    [childKeys, itemsByKey],
  );
  const { disabled: dragDisabled, onDragBegin, canCommit } = useWorkspaceFamilyDrag();
  const childDragGroup = useCallback(
    (workspace: T) => {
      if (getDragGroupKey) return getDragGroupKey(workspace);
      if (manualPins || !dragDisabled) return "siblings";
      return null;
    },
    [getDragGroupKey, manualPins, dragDisabled],
  );
  const reorder = useCallback(
    (rows: T[], move?: DragReorderMove) => {
      if (!move) return;
      const dragged = children.find((child) => child.workspaceKey === move.activeKey);
      const pinMove = manualPins || (dragged !== undefined && childDragGroup(dragged) === "pins");
      if (!canCommit(pinMove)) return;
      if (
        !isDragGroupOrderValid({
          original: children,
          reordered: rows,
          keyExtractor: workspaceKey,
          getDragGroupKey: childDragGroup,
        })
      )
        return;
      onSiblingReorder(rows);
    },
    [children, childDragGroup, canCommit, manualPins, onSiblingReorder],
  );
  const renderChild = useCallback(
    (childRow: DraggableRenderItemInfo<T>) => <WorkspaceTreeBranch {...props} row={childRow} />,
    [props],
  );
  const toggle = useCallback(() => {
    useSidebarCollapsedSectionsStore
      .getState()
      .toggleWorkspaceGroupCollapsed(workspaceCollapseKey(key));
  }, [key]);
  const activeDescendant =
    model.activeWorkspaceKey !== null &&
    (node?.descendantKeys.includes(model.activeWorkspaceKey) ?? false);
  const accessibilityState = useMemo(
    () => ({ expanded: !collapsed, disabled: activeDescendant }),
    [collapsed, activeDescendant],
  );
  if (!node) return renderRow(row);

  const summary = summarizeWorkspaceChildren({
    node,
    entries: model.entries,
    humanAttentionWorkspaceKeys: model.humanAttentionWorkspaceKeys,
  });
  // Project placements carry structural names; the row displays the resolved entry label.
  const workspace = model.entries.get(key);
  const workspaceLabel = workspace
    ? resolveSidebarWorkspacePrimaryLabel({ workspace, workspaceTitleSource })
    : row.item.name;
  const toggleLabel = t(
    collapsed ? "sidebar.workspaceTree.expand" : "sidebar.workspaceTree.collapse",
    { name: workspaceLabel },
  );
  const childContent = collapsed ? (
    <View style={styles.summary} testID={`sidebar-workspace-children-summary-${key}`}>
      <Text style={styles.summaryText}>
        {t("sidebar.workspaceTree.summary", {
          count: node.descendantKeys.length,
          status: summary.bucket
            ? getStatusBucketLabel(summary.bucket, t)
            : t("sidebar.workspaceTree.unknownStatus"),
        })}
      </Text>
      {summary.humanAttentionCount > 0 ? (
        <Text accessibilityRole="text" style={styles.attentionText}>
          {t("sidebar.workspaceTree.humanAttention", { count: summary.humanAttentionCount })}
        </Text>
      ) : null}
    </View>
  ) : (
    <View style={styles.children}>
      <DraggableList
        data={children}
        keyExtractor={workspaceKey}
        renderItem={renderChild}
        onDragEnd={reorder}
        onDragBegin={onDragBegin}
        disabled={!manualPins && children.every((child) => childDragGroup(child) === null)}
        getDragGroupKey={childDragGroup}
        testID={`sidebar-workspace-children-${key}`}
        scrollEnabled={false}
        useDragHandle
        nestable={isNative}
        simultaneousGestureRef={parentGestureRef}
        gestureHostPresented={dragGestureHostActive}
      />
    </View>
  );
  return (
    <View testID={`sidebar-workspace-family-${key}`}>
      <View style={styles.row}>
        {children.length > 0 ? (
          <PressHighlight
            accessibilityRole="button"
            accessibilityLabel={toggleLabel}
            accessibilityHint={
              activeDescendant ? t("sidebar.workspaceTree.activeChild") : undefined
            }
            accessibilityState={accessibilityState}
            aria-expanded={!collapsed}
            disabled={activeDescendant}
            onPress={toggle}
            testID={`sidebar-workspace-children-toggle-${key}`}
            style={styles.toggle}
          >
            <TreeChevron expanded={!collapsed} />
          </PressHighlight>
        ) : (
          <View style={styles.toggle} />
        )}
        <View style={styles.workspace}>{renderRow(row)}</View>
      </View>
      {children.length > 0 ? childContent : null}
    </View>
  );
}

function workspaceKey(workspace: SidebarWorkspacePlacement): string {
  return workspace.workspaceKey;
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "flex-start" },
  workspace: { flex: 1, minWidth: 0 },
  toggle: {
    width: theme.spacing[6],
    minHeight: density.rowHeight,
    alignItems: "center",
    justifyContent: "center",
  },
  children: { marginLeft: TREE_INDENT_PER_LEVEL },
  summary: {
    paddingLeft: theme.spacing[6],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1],
  },
  summaryText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  attentionText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
