import { useWindowDimensions } from "react-native";
import { SPACING } from "@/styles/theme";
import type { NaturalMessageGeometry } from "@/components/user-message-flow-model";
import {
  createContext,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface ActualPromptRows {
  scope: string;
  expandedIds: ReadonlySet<string>;
  toggleExpanded(id: string): void;
  /** Remember a native disclosure that changed only paint, without a list resize. */
  rememberExpanded(id: string, expanded: boolean): void;
  /** Route an explicit Find expansion to a mounted native presentation owner. */
  registerNativeExpansion(id: string, expand: () => void): () => void;
  expand(id: string): void;
  bodyViewportHeight: number;
  reportViewportHeight(height: number): void;
  registerViewport(prepare: (id: string) => void): () => void;
}

interface NativeExpansionOwner {
  scope: string;
  expand(): void;
}

/** The web row consumes natural flow independently of its CSS-sticky painted child. */
export const ActualPromptFlowGeometryContext = createContext<
  ((geometry: NaturalMessageGeometry | null) => void) | null
>(null);

export const ActualPinnedRowContext = createContext(false);

export const ActualPromptRowsContext = createContext<ActualPromptRows | null>(null);

/** Disclosure belongs to the message, not its current live/history or virtual lane. */
export function ActualPromptRowsProvider({
  enabled,
  scope,
  availableHeight,
  children,
}: {
  enabled: boolean;
  scope: string;
  availableHeight: number;
  children: ReactNode;
}) {
  const [pane, setPane] = useState({ scope, height: availableHeight });
  const reportViewportHeight = useCallback(
    (height: number) => {
      if (!(height > 0)) return;
      setPane((current) =>
        current.scope === scope && current.height === height ? current : { scope, height },
      );
    },
    [scope],
  );
  const measuredHeight = pane.scope === scope ? pane.height : availableHeight;
  const viewportHeight =
    availableHeight > 0 && measuredHeight > 0
      ? Math.min(availableHeight, measuredHeight)
      : Math.max(availableHeight, measuredHeight);
  const { height: windowHeight } = useWindowDimensions();
  // Keep expanded prompts below both bounds, including a landing-edge clearance.
  // The same capped column holds the body and controls; only the body scrolls.
  const bodyViewportHeight = Math.max(
    0,
    Math.min(windowHeight * 0.6, viewportHeight * 0.8) - SPACING[2],
  );
  const viewportOwner = useRef<((id: string) => void) | null>(null);
  const nativeExpansionOwners = useRef(new Map<string, NativeExpansionOwner>());
  const registerNativeExpansion = useCallback(
    (id: string, expand: () => void) => {
      const owner = { scope, expand };
      nativeExpansionOwners.current.set(id, owner);
      return () => {
        if (nativeExpansionOwners.current.get(id) === owner)
          nativeExpansionOwners.current.delete(id);
      };
    },
    [scope],
  );
  const registerViewport = useCallback((prepare: (id: string) => void) => {
    viewportOwner.current = prepare;
    return () => {
      if (viewportOwner.current === prepare) viewportOwner.current = null;
    };
  }, []);
  const [state, setState] = useState(() => ({ scope, expandedIds: new Set<string>() }));
  useLayoutEffect(() => {
    setState((current) =>
      current.scope === scope ? current : { scope, expandedIds: new Set<string>() },
    );
  }, [scope]);
  const expandedIds = useMemo(
    () => (state.scope === scope ? state.expandedIds : new Set<string>()),
    [scope, state],
  );
  const toggleExpanded = useCallback(
    (id: string) => {
      viewportOwner.current?.(id);
      setState((current) => {
        const ids = new Set(current.scope === scope ? current.expandedIds : []);
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        return { scope, expandedIds: ids };
      });
    },
    [scope],
  );
  const rememberExpanded = useCallback(
    (id: string, expanded: boolean) => {
      setState((current) => {
        if (current.scope === scope && current.expandedIds.has(id) === expanded) return current;
        const ids = new Set(current.scope === scope ? current.expandedIds : []);
        if (expanded) ids.add(id);
        else ids.delete(id);
        return { scope, expandedIds: ids };
      });
    },
    [scope],
  );
  const expand = useCallback(
    (id: string) => {
      viewportOwner.current?.(id);
      const nativeOwner = nativeExpansionOwners.current.get(id);
      if (nativeOwner?.scope === scope) nativeOwner.expand();
      setState((current) => {
        if (current.scope === scope && current.expandedIds.has(id)) return current;
        const ids = new Set(current.scope === scope ? current.expandedIds : []);
        ids.add(id);
        return { scope, expandedIds: ids };
      });
    },
    [scope],
  );
  const value = useMemo(
    () =>
      enabled
        ? {
            scope,
            expandedIds,
            toggleExpanded,
            rememberExpanded,
            registerNativeExpansion,
            expand,
            bodyViewportHeight,
            reportViewportHeight,
            registerViewport,
          }
        : null,
    [
      enabled,
      scope,
      expandedIds,
      toggleExpanded,
      rememberExpanded,
      registerNativeExpansion,
      expand,
      bodyViewportHeight,
      reportViewportHeight,
      registerViewport,
    ],
  );
  return (
    <ActualPromptRowsContext.Provider value={value}>{children}</ActualPromptRowsContext.Provider>
  );
}
