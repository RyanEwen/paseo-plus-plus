import { useCallback, useLayoutEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  ScrollView,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle,
} from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useWorkspaceTabScroll } from "./use-workspace-tab-scroll";

type TabScroll = ReturnType<typeof useWorkspaceTabScroll>;
type ScrollArguments = Parameters<ScrollView["scrollTo"]>;

const SIX_TABS = ["first", "second", "third", "fourth", "fifth", "last"];
const TEN_TABS = [...SIX_TABS, "seventh", "eighth", "ninth", "tenth"];
const LEADING_INSET = 4;
const RAIL_STYLE: ViewStyle = { width: 200, height: 48, flexGrow: 0 };
const CONTENT_STYLE: ViewStyle = { paddingHorizontal: LEADING_INSET };
const TRACK_STYLE: ViewStyle = { flexDirection: "row" };
const TAB_STYLE: ViewStyle = { width: 64, height: 44, flexShrink: 0 };

/**
 * React Native Web measures layout in a zero-delay timeout. Two macrotask turns let a reveal
 * started by a commit or a delivered callback finish measuring and scrolling.
 */
async function settleMeasurements(): Promise<void> {
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/** Held layout callbacks from an earlier commit, replayed after the selection changes. */
interface HeldCallbacks {
  viewport: () => void;
  content: () => void;
  activeTab: () => void;
}

/** Own the real rail, record its scroll commands, and hold the hook callbacks it received. */
class RailFixture {
  readonly commands: ScrollArguments[] = [];
  current: TabScroll | null = null;
  viewportEvent: LayoutChangeEvent | null = null;
  contentWidth = 0;
  element: HTMLElement | null = null;
  private restoreScrollTo: (() => void) | null = null;

  attach(scroll: ScrollView | null): void {
    this.restoreScrollTo?.();
    this.restoreScrollTo = null;
    this.element = null;
    if (!scroll) return;
    const element: unknown = scroll.getNativeScrollRef();
    if (!(element instanceof HTMLElement)) throw new TypeError("Expected the real web scroll root");
    this.element = element;
    const original = scroll.scrollTo;
    const forward = (...args: ScrollArguments): void => {
      this.commands.push(args);
      original.apply(scroll, args);
    };
    scroll.scrollTo = forward;
    this.restoreScrollTo = () => {
      scroll.scrollTo = original;
    };
  }

  /** Capture the current hook's callbacks with the geometry they were delivered. */
  hold(): HeldCallbacks {
    const current = this.requireCurrent();
    const viewportEvent = this.viewportEvent;
    const contentWidth = this.contentWidth;
    if (!viewportEvent || contentWidth <= 0) throw new Error("Expected real rail geometry");
    return {
      viewport: () => current.onLayout(viewportEvent),
      content: () => current.onContentSizeChange(contentWidth),
      activeTab: () => current.onActiveTabLayout(),
    };
  }

  requireCurrent(): TabScroll {
    if (!this.current) throw new Error("Expected the committed hook callbacks");
    return this.current;
  }

  requireElement(): HTMLElement {
    if (!this.element) throw new Error("Expected a mounted real scroll root");
    return this.element;
  }

  /** Compare actual DOM bounds of the tab against the rail. */
  isVisible(key: string): boolean {
    const rail = this.requireElement();
    const tab = rail.querySelector(`[data-testid="${key}"]`);
    if (!(tab instanceof HTMLElement)) throw new Error("Expected the exact rendered tab");
    const railRect = rail.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    return tabRect.left >= railRect.left && tabRect.right <= railRect.right;
  }
}

interface ScrollProbeProps {
  fixture: RailFixture;
  tabKeys: string[];
  activeTabKey: string | undefined;
  enabled: boolean;
}

/** Mount the production hook on a real rail shaped like the compact tab strip. */
function ScrollProbe({ fixture, tabKeys, activeTabKey, enabled }: ScrollProbeProps) {
  const offset = useSharedValue(0);
  const tabScroll = useWorkspaceTabScroll({
    activeTabKey,
    listKey: tabKeys.join("\n"),
    enabled,
    offset,
    leadingInset: LEADING_INSET,
  });
  const attach = useCallback(
    (scroll: ScrollView | null) => {
      tabScroll.scrollRef.current = scroll;
      fixture.attach(scroll);
    },
    [fixture, tabScroll.scrollRef],
  );
  useLayoutEffect(() => {
    fixture.current = tabScroll;
  });
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offset.value = event.nativeEvent.contentOffset.x;
    },
    [offset],
  );
  const { onLayout, onContentSizeChange } = tabScroll;
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      fixture.viewportEvent = event;
      onLayout(event);
    },
    [fixture, onLayout],
  );
  const handleContentSize = useCallback(
    (width: number) => {
      fixture.contentWidth = width;
      onContentSizeChange(width);
    },
    [fixture, onContentSizeChange],
  );
  return (
    <ScrollView
      ref={attach}
      horizontal
      style={RAIL_STYLE}
      contentContainerStyle={CONTENT_STYLE}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onLayout={handleLayout}
      onContentSizeChange={handleContentSize}
    >
      <View ref={tabScroll.trackRef} collapsable={false} style={TRACK_STYLE}>
        {tabKeys.map((key) => {
          const selected = key === activeTabKey;
          return (
            <View
              key={key}
              ref={selected ? tabScroll.activeTabRef : undefined}
              collapsable={false}
              onLayout={selected ? tabScroll.onActiveTabLayout : undefined}
            >
              <View testID={key} style={TAB_STYLE} />
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

/** Commit props synchronously, then let the reveal it starts finish measuring. */
async function commit(props: ScrollProbeProps): Promise<void> {
  flushSync(() => root.render(<ScrollProbe {...props} />));
  await settleMeasurements();
}

/** Seed the overflowing six-tab rail with its last tab selected and revealed. */
async function mountLast(fixture: RailFixture): Promise<HeldCallbacks> {
  await commit({ fixture, tabKeys: SIX_TABS, activeTabKey: "last", enabled: true });
  expect(fixture.isVisible("last")).toBe(true);
  expect(fixture.requireElement().scrollLeft).toBeGreaterThan(0);
  return fixture.hold();
}

it("reveals the committed selection when old layout callbacks arrive", async () => {
  const fixture = new RailFixture();
  const held = await mountLast(fixture);

  await commit({ fixture, tabKeys: SIX_TABS, activeTabKey: "first", enabled: true });
  expect(fixture.isVisible("first")).toBe(true);
  for (const deliver of [held.viewport, held.content, held.activeTab]) {
    fixture.commands.length = 0;
    deliver();
    await settleMeasurements();
    expect(fixture.commands).toEqual([[{ x: LEADING_INSET, animated: false }]]);
    expect(fixture.isVisible("first")).toBe(true);
  }
});

it("does not scroll while disabled and reveals again once enabled", async () => {
  const fixture = new RailFixture();
  const held = await mountLast(fixture);

  await commit({ fixture, tabKeys: SIX_TABS, activeTabKey: "first", enabled: false });
  fixture.commands.length = 0;
  for (const deliver of [held.viewport, held.content, held.activeTab]) {
    deliver();
    await settleMeasurements();
    expect(fixture.commands).toEqual([]);
    expect(fixture.isVisible("last")).toBe(true);
  }

  await commit({ fixture, tabKeys: SIX_TABS, activeTabKey: "first", enabled: true });
  expect(fixture.commands).toEqual([[{ x: LEADING_INSET, animated: false }]]);
  expect(fixture.isVisible("first")).toBe(true);
});

it("does not scroll without a selection and reveals the next one", async () => {
  const fixture = new RailFixture();
  const held = await mountLast(fixture);

  await commit({ fixture, tabKeys: SIX_TABS, activeTabKey: undefined, enabled: true });
  fixture.commands.length = 0;
  for (const deliver of [held.viewport, held.content, held.activeTab]) {
    deliver();
    await settleMeasurements();
    expect(fixture.commands).toEqual([]);
    expect(fixture.isVisible("last")).toBe(true);
  }

  await commit({ fixture, tabKeys: SIX_TABS, activeTabKey: "first", enabled: true });
  expect(fixture.commands).toEqual([[{ x: LEADING_INSET, animated: false }]]);
  expect(fixture.isVisible("first")).toBe(true);
});

it("keeps callbacks from an unmounted rail from scrolling either rail", async () => {
  const oldFixture = new RailFixture();
  const held = await mountLast(oldFixture);
  const retiredElement = oldFixture.requireElement();
  flushSync(() => root.render(null));
  const retiredOffset = retiredElement.scrollLeft;

  const fixture = new RailFixture();
  await mountLast(fixture);
  await commit({ fixture, tabKeys: SIX_TABS, activeTabKey: "first", enabled: true });
  oldFixture.commands.length = 0;
  fixture.commands.length = 0;
  for (const deliver of [held.viewport, held.content, held.activeTab]) {
    deliver();
    await settleMeasurements();
    expect(oldFixture.commands).toEqual([]);
    expect(fixture.commands).toEqual([]);
    expect(retiredElement.scrollLeft).toBe(retiredOffset);
    expect(fixture.isVisible("first")).toBe(true);
  }
});

it("reveals a selection that only moved when tabs to its left close", async () => {
  const fixture = new RailFixture();
  await commit({ fixture, tabKeys: TEN_TABS, activeTabKey: "fifth", enabled: true });
  expect(fixture.isVisible("fifth")).toBe(true);
  const scrolledBeforeClose = fixture.requireElement().scrollLeft;
  expect(scrolledBeforeClose).toBeGreaterThan(0);

  // Closing three tabs keeps every chip's size, so no chip reports a new layout of its own.
  await commit({
    fixture,
    tabKeys: TEN_TABS.filter((key) => !["first", "second", "third"].includes(key)),
    activeTabKey: "fifth",
    enabled: true,
  });

  expect(fixture.isVisible("fifth")).toBe(true);
});
