import { useWindowDimensions } from "react-native";
import { SPACING } from "@/styles/theme";
import type { NaturalMessageGeometry } from "@/components/prompt-message/flow-model";
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

/** Expanded prompt ids and the timeline scope they belong to. */
interface ExpansionState {
  scope: string;
  /** Whether the scope's timeline epoch was known, rather than still pending. */
  established: boolean;
  expandedIds: ReadonlySet<string>;
}

/**
 * Whether expansion recorded in `current` still applies under `scope`. A pending timeline
 * holds new submissions keyed by their client message id, and that id stays the row id when
 * a draft hands its timeline to the created agent and the epoch arrives. So a pending scope's
 * ids carry over; an established scope's ids do not, so a replaced epoch cannot revive them.
 */
function carriesExpansion(current: ExpansionState, scope: string): boolean {
  return current.scope === scope || !current.established;
}

/** A copy of the expanded ids that apply under `scope`. */
function scopedExpandedIds(current: ExpansionState, scope: string): Set<string> {
  return new Set(carriesExpansion(current, scope) ? current.expandedIds : []);
}

const NO_EXPANDED_IDS: ReadonlySet<string> = new Set();

/** Disclosure belongs to the message, not its current live/history or virtual lane. */
export function ActualPromptRowsProvider({
  enabled,
  scope,
  established = true,
  availableHeight,
  children,
}: {
  enabled: boolean;
  scope: string;
  /** Whether the scope's timeline epoch is known. A pending scope's expansion carries over. */
  established?: boolean;
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
  // Use the smaller height once both the chat and this pane are measured; until
  // then, use whichever one is known.
  const viewportHeight =
    availableHeight > 0 && measuredHeight > 0
      ? Math.min(availableHeight, measuredHeight)
      : Math.max(availableHeight, measuredHeight);
  const { height: windowHeight } = useWindowDimensions();
  // Keep expanded prompts below both bounds, including a landing-edge clearance:
  // at most 60% of the window and 80% of the pane, so the response it heads stays
  // in view while the prompt is open.
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
  const [state, setState] = useState<ExpansionState>(() => ({
    scope,
    established,
    expandedIds: NO_EXPANDED_IDS,
  }));
  // Move to the new scope's ids when the scope changes. An established epoch's ids are
  // dropped, so returning to it does not revive old expansion; a pending scope's ids carry
  // over through the draft handoff and the epoch's arrival.
  useLayoutEffect(() => {
    setState((current) => {
      if (current.scope === scope && current.established === established) return current;
      return { scope, established, expandedIds: scopedExpandedIds(current, scope) };
    });
  }, [scope, established]);
  const expandedIds = useMemo(
    () => (carriesExpansion(state, scope) ? state.expandedIds : NO_EXPANDED_IDS),
    [scope, state],
  );
  const toggleExpanded = useCallback(
    (id: string) => {
      viewportOwner.current?.(id);
      setState((current) => {
        const ids = scopedExpandedIds(current, scope);
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        return { scope, established, expandedIds: ids };
      });
    },
    [scope, established],
  );
  const rememberExpanded = useCallback(
    (id: string, expanded: boolean) => {
      setState((current) => {
        if (current.scope === scope && current.expandedIds.has(id) === expanded) return current;
        const ids = scopedExpandedIds(current, scope);
        if (expanded) ids.add(id);
        else ids.delete(id);
        return { scope, established, expandedIds: ids };
      });
    },
    [scope, established],
  );
  const expand = useCallback(
    (id: string) => {
      viewportOwner.current?.(id);
      const nativeOwner = nativeExpansionOwners.current.get(id);
      if (nativeOwner?.scope === scope) nativeOwner.expand();
      setState((current) => {
        if (current.scope === scope && current.expandedIds.has(id)) return current;
        const ids = scopedExpandedIds(current, scope);
        ids.add(id);
        return { scope, established, expandedIds: ids };
      });
    },
    [scope, established],
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
