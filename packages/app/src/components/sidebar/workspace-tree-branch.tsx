import { useCallback, useMemo, type ReactElement, type MutableRefObject } from "react";
import { Text, View } from "react-native";
import type { GestureType } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { SidebarWorkspacePlacement } from "@/hooks/use-sidebar-workspaces-list";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { isDragGroupOrderValid } from "@/components/drag-reorder/reorder-items";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  TreeChevron,
  TREE_INDENT_PER_LEVEL,
  WORKSPACE_TREE_ICON_SIZE,
} from "@/components/tree-primitives";
import { density } from "@/styles/density";
import { isNative } from "@/constants/platform";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useWorkspaceFamilyDrag } from "./use-workspace-family-drag";
import type { DragReorderMove } from "@/components/drag-reorder/reorder-items";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";
import {
  SIDEBAR_WORKSPACE_TITLE_LINE_HEIGHT,
  SidebarWorkspaceFamilyPresentationProvider,
  useSidebarWorkspaceTree,
  type SidebarWorkspaceFamilyPresentation,
} from "./workspace-tree-context";
import {
  summarizeWorkspaceChildren,
  workspaceCollapseKey,
  type WorkspaceTreeNode,
} from "./workspace-tree";
import { resolveSidebarWorkspacePrimaryLabel } from "./sidebar-workspace-title";

interface WorkspaceTreeBranchProps<T extends SidebarWorkspacePlacement> {
  row: DraggableRenderItemInfo<T>;
  depth?: number;
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
    depth = 0,
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
    (childRow: DraggableRenderItemInfo<T>) => (
      <WorkspaceTreeBranch {...props} row={childRow} depth={depth + 1} />
    ),
    [props, depth],
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
  const summary = node
    ? summarizeWorkspaceChildren({
        node,
        entries: model.entries,
        humanAttentionWorkspaceKeys: model.humanAttentionWorkspaceKeys,
      })
    : null;
  // Project placements carry structural names; the row displays the resolved entry label.
  const workspace = model.entries.get(key);
  const workspaceLabel = workspace
    ? resolveSidebarWorkspacePrimaryLabel({ workspace, workspaceTitleSource })
    : row.item.name;
  const toggleLabel = t(
    collapsed ? "sidebar.workspaceTree.expand" : "sidebar.workspaceTree.collapse",
    { name: workspaceLabel },
  );
  const hasChildren = children.length > 0;
  const showSummary = hasChildren && collapsed;
  const { summaryText, humanAttentionText } = formatWorkspaceChildrenSummary({
    showSummary,
    node,
    summary,
    t,
  });
  const presentation = useMemo<SidebarWorkspaceFamilyPresentation>(
    () => ({
      contentIndent: depth * TREE_INDENT_PER_LEVEL,
      disclosure: hasChildren ? (
        <PressHighlight
          accessibilityRole="button"
          accessibilityLabel={toggleLabel}
          accessibilityHint={activeDescendant ? t("sidebar.workspaceTree.activeChild") : undefined}
          accessibilityState={accessibilityState}
          aria-expanded={!collapsed}
          disabled={activeDescendant}
          onPress={toggle}
          testID={`sidebar-workspace-children-toggle-${key}`}
          style={styles.toggle}
        >
          <TreeChevron expanded={!collapsed} />
        </PressHighlight>
      ) : null,
      collapsedSummary: summaryText
        ? {
            id: `sidebar-workspace-children-summary-${key}`,
            description: [summaryText, humanAttentionText].filter(Boolean).join(" "),
            content: (
              <View
                style={styles.summary}
                nativeID={`sidebar-workspace-children-summary-${key}`}
                testID={`sidebar-workspace-children-summary-${key}`}
              >
                <Text style={styles.summaryText}>{summaryText}</Text>
                {humanAttentionText ? (
                  <Text accessibilityRole="text" style={styles.attentionText}>
                    {humanAttentionText}
                  </Text>
                ) : null}
              </View>
            ),
          }
        : null,
    }),
    [
      depth,
      hasChildren,
      toggleLabel,
      activeDescendant,
      t,
      accessibilityState,
      collapsed,
      toggle,
      key,
      summaryText,
      humanAttentionText,
    ],
  );
  if (!node) return renderRow(row);

  return (
    <View testID={`sidebar-workspace-family-${key}`}>
      <SidebarWorkspaceFamilyPresentationProvider value={presentation}>
        {renderRow(row)}
      </SidebarWorkspaceFamilyPresentationProvider>
      {hasChildren && !collapsed ? (
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
      ) : null}
    </View>
  );
}

/** Translate the collapsed descendant summary without changing raw status or human-attention policy. */
function formatWorkspaceChildrenSummary({
  showSummary,
  node,
  summary,
  t,
}: {
  showSummary: boolean;
  node: WorkspaceTreeNode | undefined;
  summary: ReturnType<typeof summarizeWorkspaceChildren> | null;
  t: TFunction;
}) {
  const summaryText = showSummary
    ? t("sidebar.workspaceTree.summary", {
        count: node?.descendantKeys.length ?? 0,
        status: summary?.bucket
          ? getStatusBucketLabel(summary.bucket, t)
          : t("sidebar.workspaceTree.unknownStatus"),
      })
    : null;
  const humanAttentionText =
    showSummary && summary !== null && summary.humanAttentionCount > 0
      ? t("sidebar.workspaceTree.humanAttention", { count: summary.humanAttentionCount })
      : null;
  return { summaryText, humanAttentionText };
}

function workspaceKey(workspace: SidebarWorkspacePlacement): string {
  return workspace.workspaceKey;
}

const styles = StyleSheet.create((theme) => ({
  toggle: {
    width: density.iconButton,
    height: "100%",
    alignItems: "center",
    justifyContent: "flex-start",
    // Keep the full density hit target while the glyph stays centered on the first title line.
    paddingTop:
      theme.spacing[2] + (SIDEBAR_WORKSPACE_TITLE_LINE_HEIGHT - WORKSPACE_TREE_ICON_SIZE) / 2,
  },
  summary: { marginTop: theme.spacing[1], gap: theme.spacing[1] },
  summaryText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  attentionText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
