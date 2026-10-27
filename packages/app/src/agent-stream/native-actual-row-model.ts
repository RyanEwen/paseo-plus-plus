import type { StreamRenderSegments } from "./model";
import { uniqueStreamSegments } from "./actual-row-collection";
import type {
  NaturalMessageGeometry,
  NativeMessagePresentation,
} from "@/components/user-message-flow-model";

/** One list component owns one physical FlatList. Its callbacks retain this
 * binding through dispatch, rather than acquiring the currently held list.
 */
export function createNativeViewportLifetime<
  Viewport extends object,
>(): NativeViewportRefOwner<Viewport> {
  let viewport: object | null = null;
  let attached = false;
  let refAttachment: { viewport: Viewport } | null = null;
  let ownerActive = true;
  let activationToken: object | null = null;
  let hasPublished = false;

  function isSuperseded(effects: NativeViewportRefEffects<Viewport>): boolean {
    return hasPublished && effects.lastAttachment.current?.origin !== lifetime;
  }

  /** A styling wrapper can detach and reattach its ref without replacing the
   * physical list. Keep accepted observations until a different owner claims it.
   */
  function publishRef(next: Viewport, effects: NativeViewportRefEffects<Viewport>) {
    if (!ownerActive || isSuperseded(effects)) return;
    const previous = effects.lastAttachment.current;
    if (previous?.origin !== lifetime || previous.viewport !== next) {
      effects.invalidatePendingReads();
      effects.resetMeasurements();
      effects.clearPaintedRows();
      const departingGesture = effects.getGestureOrigin();
      if (departingGesture) effects.retireGesture(departingGesture);
    }
    effects.lastAttachment.current = { origin: lifetime, viewport: next };
    effects.currentLifetime.current = lifetime;
    hasPublished = true;
    effects.setAnimatedRef(next);
    effects.setViewportIdentity(next);
  }

  const lifetime: NativeViewportRefOwner<Viewport> = {
    attach(next: object): boolean {
      if (viewport !== null && viewport !== next) return false;
      viewport = next;
      attached = true;
      return true;
    },
    release(expected: object): boolean {
      if (!attached || viewport !== expected) return false;
      attached = false;
      return true;
    },
    isCurrent(current: NativeViewportLifetime | null, held: object | null): boolean {
      return ownerActive && current === lifetime && attached && viewport === held;
    },
    readMeasurements({ current, held, measurements }) {
      return lifetime.isCurrent(current, held) ? measurements : createNativeViewportMetrics();
    },
    activate(effects) {
      if (isSuperseded(effects)) return () => {};
      const token = {};
      activationToken = token;
      ownerActive = true;
      if (refAttachment) publishRef(refAttachment.viewport, effects);

      return () => {
        if (activationToken !== token || !ownerActive) return;
        ownerActive = false;
        if (effects.currentLifetime.current === lifetime) {
          effects.currentLifetime.current = null;
          effects.invalidatePendingReads();
        }
        // Effect replay can retain this physical view. Revoke every read while
        // inactive, but retain its raw observations for an exact same-view setup.
        // Departure retires intent; reactivation never revives an old gesture.
        effects.retireGesture(lifetime);
      };
    },
    bindRef(next, effects) {
      if (!next) {
        if (refAttachment) lifetime.release(refAttachment.viewport);
        refAttachment = null;
        return;
      }
      if (isSuperseded(effects)) return;
      if (!lifetime.attach(next)) return;
      const attachment = { viewport: next };
      refAttachment = attachment;
      publishRef(next, effects);
      return () => {
        // An older cleanup cannot release a repeated same-instance attachment.
        if (refAttachment !== attachment) return;
        refAttachment = null;
        lifetime.release(next);
      };
    },
  };
  return lifetime;
}

export interface NativeViewportLifetime {
  attach(viewport: object): boolean;
  release(viewport: object): boolean;
  isCurrent(current: NativeViewportLifetime | null, held: object | null): boolean;
  /** Inactive or detached observations remain retained, but cannot be consumed. */
  readMeasurements(
    input: NativeViewportMeasurementRead,
  ): ReturnType<typeof createNativeViewportMetrics>;
}

interface NativeViewportMeasurementRead {
  current: NativeViewportLifetime | null;
  held: object | null;
  measurements: ReturnType<typeof createNativeViewportMetrics>;
}

export interface NativeViewportAttachment<Viewport extends object> {
  origin: NativeViewportLifetime;
  viewport: Viewport;
}

/** The producer supplies native mutations; the lifetime owns their ordering and
 * attachment identity. Tests call the same ref path used by the actual FlatList.
 */
export interface NativeViewportRefEffects<Viewport extends object> {
  lastAttachment: { current: NativeViewportAttachment<Viewport> | null };
  currentLifetime: { current: NativeViewportLifetime | null };
  getHeldViewport(): Viewport | null;
  getGestureOrigin(): NativeViewportLifetime | null;
  setAnimatedRef(viewport: Viewport | null): void;
  setViewportIdentity(viewport: Viewport | null): void;
  invalidatePendingReads(): void;
  resetMeasurements(): void;
  clearPaintedRows(): void;
  retireGesture(origin: NativeViewportLifetime): void;
}

export interface NativeViewportRefOwner<Viewport extends object> extends NativeViewportLifetime {
  /** Own layout-effect setup and its exact cleanup, including retained-view replay. */
  activate(effects: NativeViewportRefEffects<Viewport>): () => void;
  /** Forward an actual callback-ref attach/null/cleanup through the same token. */
  bindRef(
    viewport: Viewport | null,
    effects: NativeViewportRefEffects<Viewport>,
  ): void | (() => void);
}

/** A new native view starts with no retained layout, content or bottom offset. */
export function createNativeViewportMetrics() {
  return {
    containerKey: "native-virtualized",
    contentHeight: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null as string | null,
    contentMeasuredForKey: null as string | null,
  };
}

interface NativeStickyHeightInput {
  layoutHeight: number;
  body: NaturalMessageGeometry | null;
}

/** Keep original row spacing in flow, while collision includes the entire visible
 * message and action row. A new body cannot certify an older, shorter wrapper.
 */
export function resolveNativeStickyHeights({ layoutHeight, body }: NativeStickyHeightInput) {
  if (!body) return { flowHeight: layoutHeight, pinnedHeight: layoutHeight };
  if (layoutHeight < body.flowHeight) return null;
  return {
    flowHeight: layoutHeight,
    pinnedHeight: layoutHeight - body.flowHeight + body.visualHeight,
  };
}

/** Match RN's existing forward sticky range, with no synthetic successor. */
export function nativeStickyInterpolation(layout: number, height: number, next: number | null) {
  const inputRange = [-1, 0, layout];
  const outputRange = [0, 0, 0];
  const collision = (next ?? 0) - height;
  if (collision >= layout) {
    inputRange.push(collision, collision + 1);
    outputRange.push(collision - layout, collision - layout);
  } else {
    inputRange.push(layout + 1);
    outputRange.push(1);
  }
  return { inputRange, outputRange };
}

interface NativeBottomMeasurement {
  containerKey: string;
  contentHeight: number;
  viewportHeight: number;
  offsetY: number;
  viewportMeasuredForKey: string | null;
  contentMeasuredForKey: string | null;
}

interface NativeNearBottomPublication {
  metrics: NativeBottomMeasurement;
  threshold: number;
  publish(nearBottom: boolean): void;
}

/** Publish measured button state without requesting a scroll or changing follow mode.
 * Layout and content can arrive in either order; neither an incomplete pair nor
 * geometry retained from another container establishes the current bottom distance.
 */
export function publishMeasuredNativeNearBottom({
  metrics,
  threshold,
  publish,
}: NativeNearBottomPublication): void {
  const viewportReady =
    metrics.viewportHeight > 0 && metrics.viewportMeasuredForKey === metrics.containerKey;
  const contentReady =
    metrics.contentHeight > 0 && metrics.contentMeasuredForKey === metrics.containerKey;
  if (!viewportReady || !contentReady) return;

  const distance = nativeBottomDistance(
    metrics.contentHeight,
    0,
    metrics.viewportHeight,
    metrics.offsetY,
  );
  publish(distance <= threshold);
}

/** Raw chronological content coordinates. Keyboard motion K cancels from bottom
 * distance; it changes the visible leading edge, never H or the content offset. */
export function nativeBottomDistance(
  height: number,
  bottomInset: number,
  viewport: number,
  offset: number,
) {
  return Math.max(0, height + bottomInset - viewport - offset);
}
export function nativeJumpOffset(offset: number, top: number, inset: number, maximum: number) {
  return Math.max(0, Math.min(maximum, offset + top - inset));
}
/** Match RN 0.86.3's forward sticky interpolation, including an unknown next cell. */
export function nativeStickyTranslation(
  y: number,
  layout: number,
  height: number,
  next: number | null,
) {
  "worklet";
  const collision = (next ?? 0) - height;
  const translated = Math.max(0, y - layout);
  return collision >= layout ? Math.min(translated, collision - layout) : translated;
}

interface NativeStickyVisualInput {
  offset: number;
  leadingInset: number;
  layout: number;
  flowHeight: number;
  pinnedHeight: number;
  next: number | null;
  handoff?: "full-row";
}

interface NativeFullRowBoundary {
  layout: number;
  flowHeight: number;
  leading: number;
}

/** The half-open ordinary row has no pixels below the actual leading edge. */
export function nativeFullRowExited(input: NativeFullRowBoundary): boolean {
  "worklet";
  return input.flowHeight > 0 && input.layout + input.flowHeight <= input.leading;
}

export interface NativeStickyGeometry {
  binding: number;
  ready: boolean;
  y: number;
  flowHeight: number;
  next: number | null;
}

/** Unknown successor layout cannot establish a takeover. */
export function nativeStickySuccessorOwnsEdge(next: number | null, leading: number): boolean {
  "worklet";
  return next !== null && leading >= next;
}

/** A successor owns the edge when its natural top arrives, while its full body
 * still paints ordinarily. Unknown successor layout is not proof of history end.
 */
export function nativeStickyRowOwnsEdge(geometry: NativeStickyGeometry, leading: number): boolean {
  "worklet";
  const beforeSuccessor = !nativeStickySuccessorOwnsEdge(geometry.next, leading);
  return (
    geometry.ready &&
    beforeSuccessor &&
    nativeFullRowExited({ layout: geometry.y, flowHeight: geometry.flowHeight, leading })
  );
}

interface NativeStickyPresentationStyleInput {
  enabled: boolean;
  binding: number;
  activeBinding: number;
  geometry: NativeStickyGeometry;
  presentation: NativeMessagePresentation;
  leading: number;
}

/** Explicit More may cover later content without scrolling the transcript.
 * Current geometry revokes that exception before a stale expanded frame can
 * cover the next owner; compact retains the ordinary push-away calculation.
 */
export function nativeStickyPresentationStyle(input: NativeStickyPresentationStyleInput) {
  "worklet";
  const { geometry, presentation, leading, binding } = input;
  const current =
    input.enabled &&
    input.activeBinding === binding &&
    geometry.binding === binding &&
    presentation.binding === binding &&
    presentation.mode !== "ordinary" &&
    presentation.flowHeight > 0 &&
    nativeStickyRowOwnsEdge(geometry, leading);
  const expanded = current && presentation.mode === "expanded";
  const collision = expanded ? null : geometry.next;
  const height = geometry.flowHeight - presentation.flowHeight + presentation.visualHeight;
  const translateY = current ? nativeStickyTranslation(leading, geometry.y, height, collision) : 0;
  // The translated root is a direct ScrollView child, alongside sticky roots at level 10.
  const zIndex = expanded ? 20 : 10;
  return { transform: [{ translateY }], overflow: "visible" as const, zIndex };
}

/** Android ordinary paint remains natural until the entire original row exits.
 * iOS retains its existing top-trigger owner until its separate migration.
 */
export function nativeFullRowStickyTranslation(input: NativeStickyVisualInput): number {
  "worklet";
  const leading = input.offset + input.leadingInset;
  if (!nativeFullRowExited({ layout: input.layout, flowHeight: input.flowHeight, leading }))
    return 0;
  return nativeStickyTranslation(leading, input.layout, input.pinnedHeight, input.next);
}

/** Correct RN's full-flow outer transform using the whole visible sticky extent. */
export function nativeStickyVisualDelta(input: NativeStickyVisualInput): number {
  "worklet";
  const visible =
    input.handoff === "full-row"
      ? nativeFullRowStickyTranslation(input)
      : nativeStickyTranslation(
          input.offset + input.leadingInset,
          input.layout,
          input.pinnedHeight,
          input.next,
        );
  const original = nativeStickyTranslation(
    input.offset,
    input.layout,
    input.flowHeight,
    input.next,
  );
  return visible - original;
}

export function nativeOriginalTop(
  layout: number,
  offset: number,
  listTop: number,
  clipTop: number,
) {
  return layout - offset + listTop - Math.max(clipTop, listTop);
}

/** Canonical IDs are the one list-cell key across all former rendering lanes. */
export function nativeChronologicalRows(segments: StreamRenderSegments) {
  const unique = uniqueStreamSegments(segments);
  return [...unique.historyVirtualized, ...unique.historyMounted, ...unique.liveHead];
}

export interface ActualNativeRowGeometry {
  index: number;
  y: number;
  height: number;
  pinnedHeight?: number;
  fullRowReady?: boolean;
}
interface NativeMeasuredHeader {
  index: number;
  y: number;
}
export interface NativeMeasuredHeaderIndex {
  record(id: string, geometry: ActualNativeRowGeometry): void;
  nextTop(index: number): number | null;
  clear(): void;
}

/** Return the first measured header at or after a chronological row index. */
function nativeHeaderPosition(headers: readonly NativeMeasuredHeader[], index: number): number {
  let first = 0;
  let last = headers.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if (headers[middle].index < index) first = middle + 1;
    else last = middle;
  }
  return first;
}

/** Bind measured USER successors to one immutable chronological row array.
 * Unmounted and zero-height headers still own collision boundaries. Rebuild on
 * a row/scope rebind; only USER layout changes update this index between reads.
 */
export function createNativeMeasuredHeaderIndex({
  items,
  geometry,
}: {
  items: readonly import("@/types/stream").StreamItem[];
  geometry: ReadonlyMap<string, ActualNativeRowGeometry>;
}): NativeMeasuredHeaderIndex {
  const headers: NativeMeasuredHeader[] = [];
  const indices = new Map<string, number>();
  function measuredHeader(id: string, row: ActualNativeRowGeometry) {
    const item = items[row.index];
    if (item?.id !== id || item.kind !== "user_message") return null;
    return { index: row.index, y: row.y };
  }
  // Rebinding pays one chronological pass; scroll reads never rebuild the index.
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const row = geometry.get(item.id);
    if (item.kind !== "user_message" || row?.index !== index) continue;
    headers.push({ index, y: row.y });
    indices.set(item.id, index);
  }

  return {
    record(id, row) {
      const header = measuredHeader(id, row);
      if (!header) {
        const previousIndex = indices.get(id);
        if (previousIndex !== undefined) {
          headers.splice(nativeHeaderPosition(headers, previousIndex), 1);
          indices.delete(id);
        }
        return;
      }
      const position = nativeHeaderPosition(headers, row.index);
      if (headers[position]?.index === row.index) headers[position] = header;
      else headers.splice(position, 0, header);
      indices.set(id, row.index);
    },
    nextTop(index) {
      const position = nativeHeaderPosition(headers, index + 1);
      return headers[position]?.y ?? null;
    },
    clear() {
      headers.length = 0;
      indices.clear();
    },
  };
}

/** A native measurement may publish only for its current request and row/scope binding. */
export function isCurrentNativeReading({
  request,
  latestRequest,
  headers,
  currentHeaders,
}: {
  request: number;
  latestRequest: number;
  headers: NativeMeasuredHeaderIndex;
  currentHeaders: NativeMeasuredHeaderIndex;
}): boolean {
  return request === latestRequest && headers === currentHeaders;
}

interface ActualNativeReadingInput {
  items: readonly import("@/types/stream").StreamItem[];
  geometry: ReadonlyMap<string, ActualNativeRowGeometry>;
  mounted: ReadonlySet<string>;
  headers: NativeMeasuredHeaderIndex;
  offset: number;
  viewportHeight: number;
  clippedLeading: number;
  stickyEnabled: boolean;
  handoff?: "full-row";
}
function collectOriginalNativeRows(
  input: ActualNativeReadingInput,
  leading: number,
  trailing: number,
) {
  let pinnedIndex = -1;
  let firstVisibleIndex = Infinity;
  const visibleUserIndices: number[] = [];
  for (const id of input.mounted) {
    const row = input.geometry.get(id);
    if (!row || !(row.height > 0)) continue;
    const item = input.items[row.index];
    if (item?.id !== id) continue;
    const index = row.index;
    const passed =
      input.handoff === "full-row"
        ? nativeFullRowExited({ layout: row.y, flowHeight: row.height, leading })
        : row.y <= leading;
    const presentationReady = input.handoff !== "full-row" || row.fullRowReady !== false;
    if (input.stickyEnabled && presentationReady && item.kind === "user_message" && passed)
      pinnedIndex = Math.max(pinnedIndex, index);
    if (row.y < trailing && row.y + row.height > leading) {
      firstVisibleIndex = Math.min(firstVisibleIndex, index);
      if (item.kind === "user_message") visibleUserIndices.push(index);
    }
  }
  return { pinnedIndex, firstVisibleIndex, visibleUserIndices };
}
function retainedNativePromptIsVisible(
  input: ActualNativeReadingInput,
  index: number,
  leading: number,
  trailing: number,
) {
  const pinned = input.items[index];
  if (!pinned || !(trailing > leading)) return false;
  const row = input.geometry.get(pinned.id)!;
  const pinnedHeight = row.pinnedHeight ?? row.height;
  const top =
    row.y + nativeStickyTranslation(leading, row.y, pinnedHeight, input.headers.nextTop(index));
  return top < trailing && top + pinnedHeight > leading;
}
export function resolveActualNativeReading(input: ActualNativeReadingInput) {
  const leading = input.offset + Math.max(0, input.clippedLeading);
  const trailing = input.offset + input.viewportHeight;
  const { pinnedIndex, firstVisibleIndex, visibleUserIndices } = collectOriginalNativeRows(
    input,
    leading,
    trailing,
  );
  const pinned = input.items[pinnedIndex];
  const pinnedVisible = retainedNativePromptIsVisible(input, pinnedIndex, leading, trailing);
  const visibleIndices = trailing > leading ? visibleUserIndices : [];
  if (pinnedVisible && !visibleIndices.includes(pinnedIndex)) visibleIndices.push(pinnedIndex);
  visibleIndices.sort((left, right) => left - right);
  let first = trailing > leading ? input.items[firstVisibleIndex] : undefined;
  if (!first && pinnedVisible) first = pinned;
  return {
    pinnedId: pinnedVisible ? pinned.id : null,
    rowId: first?.id ?? null,
    seq: first?.timelineCursor?.seq ?? null,
    visibleUserIds: visibleIndices.map((index) => input.items[index].id),
  };
}

/** Only the explicitly standalone child topology may omit BOTH dock contracts. */
export function resolveNativeMotionOwner(
  allowStandalone: boolean,
  hasMotion: boolean,
  hasStationaryClip: boolean,
): "docked" | "standalone" {
  if (hasMotion && hasStationaryClip) return "docked";
  if (allowStandalone && !hasMotion && !hasStationaryClip) return "standalone";
  throw new Error("Native transcript motion and stationary viewport owners must match");
}
export function resolveNativeMeasurementOwner<T>(
  mode: "docked" | "standalone",
  viewport: T | null,
  stationaryClip: T | null,
) {
  if (!viewport) return null;
  const clip = mode === "standalone" ? viewport : stationaryClip;
  return clip ? { viewport, clip } : null;
}
