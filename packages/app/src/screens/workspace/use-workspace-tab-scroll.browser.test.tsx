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

interface HeldLayout {
  event: LayoutChangeEvent;
  deliver: () => void;
}

interface HeldFrame extends HeldLayout {
  deliverFrame: () => void;
}

interface HeldGeometry {
  viewport: HeldLayout;
  content: { width: number; deliver: () => void };
  frames: HeldFrame[];
  lateDeliveries: Array<() => void>;
}

const TAB_KEYS = ["first", "second", "third", "fourth", "fifth", "last"];
const RAIL_STYLE: ViewStyle = { width: 200, height: 48, flexGrow: 0 };
const CONTENT_STYLE: ViewStyle = { flexDirection: "row" };
const TAB_STYLE: ViewStyle = { width: 64, height: 44, flexShrink: 0 };

/** Own actual RNW deliveries and an instance-only forwarding command recorder. */
class RailFixture {
  readonly ready = Promise.withResolvers<void>();
  readonly frames = new Map<string, HeldFrame>();
  readonly commands: ScrollArguments[] = [];
  viewport: HeldLayout | null = null;
  content: HeldGeometry["content"] | null = null;
  current: TabScroll | null = null;
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

  /** Resolve from actual delivered geometry, without clocks or invented layout events. */
  measured(): void {
    if (this.viewport && this.content && this.frames.size === TAB_KEYS.length) {
      this.ready.resolve();
    }
  }

  hold(): HeldGeometry {
    if (!this.viewport || !this.content || this.frames.size !== TAB_KEYS.length) {
      throw new Error("Expected all real rail measurements before holding callbacks");
    }
    const frames = TAB_KEYS.map((key) => {
      const frame = this.frames.get(key);
      if (!frame) throw new Error(`Expected the real frame for ${key}`);
      return frame;
    });
    return {
      viewport: this.viewport,
      content: this.content,
      frames,
      lateDeliveries: [
        this.viewport.deliver,
        this.content.deliver,
        frames[0].deliver,
        frames[0].deliverFrame,
      ],
    };
  }

  /** Seed the real overflowing rail with its last tab selected before holding delivery. */
  async mountLast(): Promise<HeldGeometry> {
    commit({ fixture: this, activeTabKey: "last", enabled: true });
    await this.ready.promise;
    const held = this.hold();
    held.viewport.deliver();
    held.content.deliver();
    for (const frame of held.frames) frame.deliver();
    this.expectVisible("last");
    expect(this.requireElement().scrollLeft).toBeGreaterThan(0);
    return held;
  }

  requireCurrent(): TabScroll {
    if (!this.current) throw new Error("Expected the committed hook callbacks");
    return this.current;
  }

  requireElement(): HTMLElement {
    if (!this.element) throw new Error("Expected a mounted real scroll root");
    return this.element;
  }

  /** Compare actual DOM bounds after each command, not just the final accumulated offset. */
  expectVisible(key: string): void {
    const rail = this.requireElement();
    const tab = rail.querySelector(`[data-testid="${key}"]`);
    if (!(tab instanceof HTMLElement)) throw new Error("Expected the exact rendered tab");
    const railRect = rail.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    expect(tabRect.width).toBe(64);
    expect(tabRect.height).toBe(44);
    expect(tabRect.left).toBeGreaterThanOrEqual(railRect.left);
    expect(tabRect.right).toBeLessThanOrEqual(railRect.right);
  }
}

interface ScrollProbeProps {
  fixture: RailFixture;
  activeTabKey: string | undefined;
  enabled: boolean;
}

interface MeasuredTabProps {
  tabKey: string;
  fixture: RailFixture;
  onTabLayout: TabScroll["onTabLayout"];
  onTabFrame: TabScroll["onTabFrame"];
}

/** Hold each real View event with the hook callbacks that received that delivery. */
function MeasuredTab({ tabKey, fixture, onTabLayout, onTabFrame }: MeasuredTabProps) {
  const capture = useCallback(
    (event: LayoutChangeEvent) => {
      if (event.nativeEvent.layout.width <= 0) return;
      fixture.frames.set(tabKey, {
        event,
        deliver: () => onTabLayout(tabKey, event),
        deliverFrame: () => onTabFrame(tabKey, event.nativeEvent.layout),
      });
      fixture.measured();
    },
    [fixture, tabKey, onTabLayout, onTabFrame],
  );
  return <View testID={tabKey} style={TAB_STYLE} onLayout={capture} />;
}

/** Mount the production hook and real hosts while holding only delivery to that hook. */
function ScrollProbe({ fixture, activeTabKey, enabled }: ScrollProbeProps) {
  const offset = useSharedValue(0);
  const tabScroll = useWorkspaceTabScroll({ activeTabKey, enabled, offset });
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
  const captureLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (event.nativeEvent.layout.width <= 0) return;
      fixture.viewport = { event, deliver: () => onLayout(event) };
      fixture.measured();
    },
    [fixture, onLayout],
  );
  const captureContent = useCallback(
    (width: number) => {
      if (width <= 0) return;
      fixture.content = { width, deliver: () => onContentSizeChange(width) };
      fixture.measured();
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
      onLayout={captureLayout}
      onContentSizeChange={captureContent}
    >
      {TAB_KEYS.map((key) => (
        <MeasuredTab
          key={key}
          tabKey={key}
          fixture={fixture}
          onTabLayout={tabScroll.onTabLayout}
          onTabFrame={tabScroll.onTabFrame}
        />
      ))}
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

/** Commit props synchronously so saved measurement delivery is strictly after that commit. */
function commit(props: ScrollProbeProps): void {
  flushSync(() => root.render(<ScrollProbe {...props} />));
}

it("reveals the committed selection when old measured callbacks arrive", async () => {
  const fixture = new RailFixture();
  const held = await fixture.mountLast();

  commit({ fixture, activeTabKey: "first", enabled: true });
  fixture.expectVisible("first");
  for (const deliver of held.lateDeliveries) {
    fixture.commands.length = 0;
    deliver();
    expect(fixture.commands).toEqual([[{ x: 0, animated: false }]]);
    fixture.expectVisible("first");
  }
});

it("suppresses retained measurements while disabled and resumes current callbacks", async () => {
  const fixture = new RailFixture();
  const held = await fixture.mountLast();
  commit({ fixture, activeTabKey: "first", enabled: false });
  fixture.commands.length = 0;
  for (const deliver of held.lateDeliveries) {
    deliver();
    expect(fixture.commands).toEqual([]);
    fixture.expectVisible("last");
  }

  commit({ fixture, activeTabKey: "first", enabled: true });
  expect(fixture.commands).toEqual([[{ x: 0, animated: false }]]);
  fixture.commands.length = 0;
  fixture.requireCurrent().onLayout(held.viewport.event);
  expect(fixture.commands).toEqual([[{ x: 0, animated: false }]]);
  fixture.expectVisible("first");
});

it("suppresses retained measurements without a selection and resumes current frames", async () => {
  const fixture = new RailFixture();
  const held = await fixture.mountLast();
  commit({ fixture, activeTabKey: undefined, enabled: true });
  fixture.commands.length = 0;
  for (const deliver of held.lateDeliveries) {
    deliver();
    expect(fixture.commands).toEqual([]);
    fixture.expectVisible("last");
  }

  commit({ fixture, activeTabKey: "first", enabled: true });
  expect(fixture.commands).toEqual([[{ x: 0, animated: false }]]);
  fixture.commands.length = 0;
  fixture.requireCurrent().onTabFrame("first", held.frames[0].event.nativeEvent.layout);
  expect(fixture.commands).toEqual([[{ x: 0, animated: false }]]);
  fixture.expectVisible("first");
});

it("keeps retired callbacks from commanding either rail after unmount", async () => {
  const oldFixture = new RailFixture();
  const held = await oldFixture.mountLast();
  const retiredElement = oldFixture.requireElement();
  flushSync(() => root.render(null));
  const retiredOffset = retiredElement.scrollLeft;

  const fixture = new RailFixture();
  const current = await fixture.mountLast();
  commit({ fixture, activeTabKey: "first", enabled: true });
  oldFixture.commands.length = 0;
  fixture.commands.length = 0;
  for (const deliver of held.lateDeliveries) {
    deliver();
    expect(oldFixture.commands).toEqual([]);
    expect(fixture.commands).toEqual([]);
    expect(retiredElement.scrollLeft).toBe(retiredOffset);
    fixture.expectVisible("first");
  }

  fixture.requireCurrent().onLayout(current.viewport.event);
  expect(fixture.commands).toEqual([[{ x: 0, animated: false }]]);
  fixture.expectVisible("first");
});
