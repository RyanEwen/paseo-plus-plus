import { nativeTextPreviewMetrics } from "./ui/native-text-preview-metrics";

export interface NaturalTextLine {
  y: number;
  height: number;
  width: number;
}

export interface MessageTextBinding {
  key: object;
  message: string;
  fontScale: number;
  width: number | null;
}

export interface MessageTextPrefix extends MessageTextBinding {
  height: number;
  shape: string;
}

interface MessageTextLayoutInput {
  binding: MessageTextBinding;
  previous: MessageTextPrefix | null;
  lines: readonly NaturalTextLine[];
  bounded: boolean;
}

interface MessageTextRebindInput {
  prefix: MessageTextPrefix | null;
  binding: MessageTextBinding;
}

/** Retain the actual fresh lines before releasing a pinned width. The replacement
 * binding can recover from frame measurements alone when that width still matches.
 */
export function readMessageTextLayout({
  binding,
  previous,
  lines,
  bounded,
}: MessageTextLayoutInput) {
  const { height } = nativeTextPreviewMetrics(lines, 1);
  const shape = lines.map((line) => `${line.y}:${line.height}:${line.width}`).join(";");
  const prefix: MessageTextPrefix = { ...binding, height, shape };
  const changedShape = previous?.key === binding.key && previous.shape !== shape;
  const measuredWidth = binding.width !== null && binding.width > 0;
  return { prefix, rebind: bounded && changedShape && measuredWidth };
}

/** A current frame may carry real line measurements across a binding replacement.
 * Unknown width is usable only for its original binding's first frame; different
 * text, font scale or measured width requires a new natural Text event.
 */
export function rebindMessageTextPrefix({
  prefix,
  binding,
}: MessageTextRebindInput): MessageTextPrefix | null {
  if (!prefix || prefix.message !== binding.message || prefix.fontScale !== binding.fontScale) {
    return null;
  }
  if (binding.width === null || !(binding.width > 0)) return null;
  const sameWidth = prefix.width === binding.width;
  const firstCurrentFrame = prefix.key === binding.key && prefix.width === null;
  if (!sameWidth && !firstCurrentFrame) return null;
  return { ...prefix, key: binding.key, width: binding.width };
}

export interface MessageFlowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NaturalMessageGeometry {
  flowHeight: number;
  visualHeight: number;
}

export interface MessageFlowMeasurements {
  width: number;
  bodyHeight: number | null;
  trailingHeight: number | null;
  bubble: MessageFlowFrame | null;
  content: MessageFlowFrame | null;
  text: MessageFlowFrame | null;
  prefixHeight: number | null;
  controls: MessageFlowFrame | null;
}

interface MessageFlowInput {
  measurements: MessageFlowMeasurements;
  hasText: boolean;
}

/** Derive both extents from the one ordinary body and its measured action row.
 * The viewport can collapse without changing the natural content or its width.
 * Missing measurements keep ordinary flow; zero is valid for an absent action row.
 */
export function resolveMessageFlow({ measurements: m, hasText }: MessageFlowInput) {
  const bodyHeight = m.bodyHeight;
  const trailingHeight = m.trailingHeight;
  const textReady = !hasText || (m.text !== null && m.prefixHeight !== null);
  if (
    bodyHeight === null ||
    bodyHeight <= 0 ||
    trailingHeight === null ||
    !textReady ||
    !m.bubble ||
    !m.content ||
    !m.controls
  ) {
    return null;
  }
  if (!(m.width > 0) || !(m.bubble.width > 0)) return null;

  // Both values include actual layout, not reconstructed theme padding or line counts.
  const bubbleChrome = Math.max(0, m.bubble.height - m.content.height);
  const prefixHeight = hasText ? (m.prefixHeight ?? 0) : 0;
  const compactHeight = Math.max(prefixHeight, m.controls.height) + bubbleChrome;
  const flowHeight = bodyHeight + trailingHeight;
  const textWidth = m.text?.width ?? 0;
  const paddingWidth = Math.max(0, m.bubble.width - m.content.width);
  const availableTextWidth = Math.max(0, m.width - paddingWidth - m.controls.width);
  return {
    flowHeight,
    compactHeight,
    bubbleChrome,
    bubbleWidth: m.bubble.width,
    textWidth,
    textClipWidth: Math.min(textWidth, availableTextWidth),
    textTranslateX: -m.bubble.x,
    textTranslateY: 0 - (m.text?.y ?? 0),
  };
}

export type NativeMessageMode = "ordinary" | "compact" | "expanded";
export type NativeMessageRole = "compact" | "expanded" | "body" | "pinned";

/** Paint, native hit testing and descendant accessibility use this same gate. */
export function nativeMessageRoleVisible(
  mode: NativeMessageMode,
  role: NativeMessageRole,
): boolean {
  "worklet";
  if (role === "body") return mode !== "compact";
  if (role === "pinned") return mode !== "ordinary";
  return mode === role;
}

/** Complete ordinary measurements, never dimensions read from a compact viewport. */
export interface NativeMessagePreparation {
  revision: number;
  flowHeight: number;
  bodyHeight: number;
  trailingHeight: number;
  controlsHeight: number;
  compactHeight: number;
  maximumHeight: number;
  textWidth: number;
  textClipWidth: number;
  textTranslateX: number;
  textTranslateY: number;
  prefixHeight: number;
  controlsTop: number;
  controlsRight: number;
}

export interface NativeMessagePresentation {
  binding: number;
  mode: NativeMessageMode;
  revision: number;
  cycle: number;
  flowHeight: number;
  bodyHeight: number | "auto";
  disclosureHeight: number;
  visualHeight: number;
  textClipWidth: number | "auto";
  textTranslateX: number;
  textTranslateY: number;
  prefixHeight: number;
  controlsTop: number;
  controlsRight: number;
}

interface NativeMessagePreparationInput {
  measurements: MessageFlowMeasurements;
  flow: ReturnType<typeof resolveMessageFlow>;
  revision: number;
  requiresControls?: boolean;
}

/** Only a complete natural-body snapshot can prepare a native presentation.
 * The caller supplies the current UI viewport cap when consuming this snapshot.
 */
export function prepareNativeMessagePresentation({
  measurements: m,
  flow,
  revision,
  requiresControls = false,
}: NativeMessagePreparationInput): NativeMessagePreparation | null {
  if (!flow || m.bodyHeight === null || m.trailingHeight === null || !m.controls || !m.content)
    return null;
  if (requiresControls && !(m.controls.width > 0 && m.controls.height > 0)) return null;
  // A control already includes its hit-target height. Ordinary bubble padding
  // surrounds the text line, rather than being added around the control again.
  const prefixHeight = m.prefixHeight ?? 0;
  const compactHeight = Math.max(prefixHeight + flow.bubbleChrome, m.controls.height);
  const textTop = (compactHeight - prefixHeight) / 2;
  return {
    revision,
    flowHeight: flow.flowHeight,
    bodyHeight: m.bodyHeight,
    trailingHeight: m.trailingHeight,
    controlsHeight: m.controls.height,
    compactHeight,
    maximumHeight: 0,
    textWidth: flow.textWidth,
    textClipWidth: flow.textClipWidth,
    textTranslateX: flow.textTranslateX,
    textTranslateY: textTop - m.content.y - (m.text?.y ?? 0),
    prefixHeight,
    controlsTop: (compactHeight - m.controls.height) / 2,
    controlsRight: m.content.x,
  };
}

interface NativeMessageViewportGeometryInput extends Pick<
  MessageFlowMeasurements,
  "width" | "bubble"
> {
  mode: NativeMessageMode;
}

/** Clip pinned paint without narrowing the ScrollView's one natural body.
 * Expanded paint follows its measured bubble; compact text and controls use
 * the chat rail. Opposite offsets keep the natural body's physical origin.
 */
export function nativeMessageViewportGeometry({
  width,
  bubble,
  mode,
}: NativeMessageViewportGeometryInput) {
  "worklet";
  const naturalWidth = width > 0 ? width : ("100%" as const);
  const inset = mode === "expanded" && bubble !== null ? bubble.x : 0;
  const clipWidth = mode === "expanded" && bubble !== null ? bubble.width : naturalWidth;
  const bodyLeft = inset === 0 ? 0 : -inset;
  return { clipLeft: inset, clipWidth, bodyLeft, bodyWidth: naturalWidth };
}

export interface NativeMessagePreparationBinding {
  key: object;
  measurements: MessageFlowMeasurements;
  requiresControls: boolean;
  revision: number;
  value: NativeMessagePreparation | null;
}

interface NativeMessagePreparationBindingInput extends Omit<
  NativeMessagePreparationInput,
  "revision"
> {
  key: object;
  previous: NativeMessagePreparationBinding | null;
}

/** Effect cleanup/setup replay retains the same natural observation. A new
 * measurement or binding gets a new revision, even when dimensions happen to match.
 */
export function bindNativeMessagePreparation(
  input: NativeMessagePreparationBindingInput,
): NativeMessagePreparationBinding {
  const { previous, key, measurements, requiresControls = false } = input;
  if (
    previous?.key === key &&
    previous.measurements === measurements &&
    previous.requiresControls === requiresControls
  )
    return previous;
  const revision = (previous?.revision ?? 0) + 1;
  return {
    key,
    measurements,
    requiresControls,
    revision,
    value: prepareNativeMessagePresentation({
      measurements,
      flow: input.flow,
      revision,
      requiresControls,
    }),
  };
}

/** Initial native presentation has no prepared measurements or active disclosure. */
export function ordinaryNativeMessagePresentation(): NativeMessagePresentation {
  "worklet";
  return {
    binding: 0,
    mode: "ordinary",
    revision: 0,
    cycle: 0,
    flowHeight: 0,
    bodyHeight: "auto",
    disclosureHeight: 0,
    visualHeight: 0,
    textClipWidth: "auto",
    textTranslateX: 0,
    textTranslateY: 0,
    prefixHeight: 0,
    controlsTop: 0,
    controlsRight: 0,
  };
}

interface NativeMessageTransition {
  binding: number;
  previous: NativeMessagePresentation;
  prepared: NativeMessagePreparation | null;
  eligible: boolean;
  expanded: boolean;
  /** The current held inner viewport must reset synchronously or throw. */
  resetBody(): void;
}

/** Pinning needs both a complete natural-body snapshot and room for its controls. */
function resolveNativeMessageMode({
  prepared,
  eligible,
  expanded,
}: Pick<NativeMessageTransition, "prepared" | "eligible" | "expanded">): NativeMessageMode {
  "worklet";
  const capReady =
    prepared !== null && prepared.maximumHeight > prepared.trailingHeight + prepared.controlsHeight;
  if (eligible && prepared && capReady) return expanded ? "expanded" : "compact";
  return "ordinary";
}

interface NativePinnedMessageIdentity extends Pick<
  NativeMessagePresentation,
  "binding" | "revision" | "cycle"
> {
  mode: "compact" | "expanded";
}

/** Project the prepared body's visual cap after the transition has reset any old inner scroll. */
function projectNativePinnedMessage(
  prepared: NativeMessagePreparation,
  identity: NativePinnedMessageIdentity,
): NativeMessagePresentation {
  "worklet";
  const compact = identity.mode === "compact";
  const controlsHeight = identity.mode === "expanded" ? prepared.controlsHeight : 0;
  const cap = Math.max(0, prepared.maximumHeight - prepared.trailingHeight - controlsHeight);
  const desiredBodyHeight = compact ? prepared.compactHeight : prepared.bodyHeight;
  const bodyHeight = Math.min(desiredBodyHeight, cap);
  return {
    ...identity,
    flowHeight: prepared.flowHeight,
    bodyHeight,
    disclosureHeight: controlsHeight,
    visualHeight: bodyHeight + controlsHeight + prepared.trailingHeight,
    textClipWidth: compact ? prepared.textClipWidth : prepared.textWidth,
    textTranslateX: compact ? prepared.textTranslateX : 0,
    textTranslateY: compact ? prepared.textTranslateY : 0,
    prefixHeight: prepared.prefixHeight,
    controlsTop: prepared.controlsTop,
    controlsRight: prepared.controlsRight,
  };
}

/** One UI transition owns painting and interaction. Reset More's actual inner
 * viewport before publishing compact/ordinary mode, including a binding change.
 * A reset failure leaves the new mode unpublished rather than claiming success.
 */
export function advanceNativeMessagePresentation({
  binding,
  previous,
  prepared,
  eligible,
  expanded,
  resetBody,
}: NativeMessageTransition): NativeMessagePresentation {
  "worklet";
  const mode = resolveNativeMessageMode({ prepared, eligible, expanded });
  const revision = prepared?.revision ?? 0;
  const rebound = previous.binding !== binding || previous.revision !== revision;
  if (previous.mode === "expanded" && (mode !== "expanded" || rebound)) resetBody();
  const crossed = previous.mode === "ordinary" && mode !== "ordinary";
  const cycle = previous.cycle + (crossed || rebound ? 1 : 0);
  if (mode === "ordinary" || !prepared) {
    return {
      ...ordinaryNativeMessagePresentation(),
      revision,
      cycle,
      binding,
      flowHeight: prepared?.flowHeight ?? 0,
      controlsTop: prepared?.controlsTop ?? 0,
      controlsRight: prepared?.controlsRight ?? 0,
    };
  }
  return projectNativePinnedMessage(prepared, {
    binding,
    mode,
    revision,
    cycle,
  });
}

/** Queued More/Less presses cannot change a different row or a later handoff. */
export function acceptsNativeMessageDisclosure(
  presentation: NativeMessagePresentation,
  revision: number,
  cycle: number,
  expected: NativeMessageMode,
): boolean {
  "worklet";
  return (
    presentation.mode === expected &&
    presentation.revision === revision &&
    presentation.cycle === cycle
  );
}
