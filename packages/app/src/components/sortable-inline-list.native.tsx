import type { ReactElement } from "react";
import type { DraggableRenderItemInfo } from "./draggable-list.types";
import { View } from "react-native";
import { useSortableItemLayout, type SortableItemLayoutHandler } from "./use-sortable-item-layout";

export function SortableInlineList<T>({
  data,
  keyExtractor,
  renderItem,
  onItemLayout,
}: {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  onDragEnd?: (data: T[]) => void;
  useDragHandle?: boolean;
  disabled?: boolean;
  externalDndContext?: boolean;
  activeId?: string | null;
  getItemData?: (item: T, index: number) => Record<string, unknown>;
  /** Report actual outer-item frames in the immediate parent's coordinate space. */
  onItemLayout?: SortableItemLayoutHandler<T>;
}): ReactElement {
  return (
    <>
      {data.map((item, index) => {
        const id = keyExtractor(item, index);
        return (
          <SortableInlineListItem
            key={id}
            item={item}
            index={index}
            renderItem={renderItem}
            orderRevision={data}
            onItemLayout={onItemLayout}
          />
        );
      })}
    </>
  );
}

function SortableInlineListItem<T>({
  item,
  index,
  renderItem,
  orderRevision,
  onItemLayout,
}: {
  item: T;
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  orderRevision: readonly T[];
  onItemLayout?: SortableItemLayoutHandler<T>;
}): ReactElement {
  const layout = useSortableItemLayout({ item, index, orderRevision, onItemLayout });
  const info: DraggableRenderItemInfo<T> = {
    item,
    index,
    drag: () => {},
    isActive: false,
  };
  if (onItemLayout) {
    return (
      <View ref={layout.ref} onLayout={layout.onLayout}>
        {renderItem(info)}
      </View>
    );
  }
  return renderItem(info);
}
