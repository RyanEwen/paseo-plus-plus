import { useCallback, useContext, useMemo, useState, type ComponentProps } from "react";
import type { GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { isWeb } from "@/constants/platform";
import { Button } from "@/components/ui/button";
import type { UserMessage } from "@/components/message";
import { ActualPinnedRowContext, ActualPromptRowsContext } from "./actual-prompt-rows";
import { PromptNavigationContext } from "./prompt-navigation-actions";
import { PinnedMessageActionBackdrop } from "./pinned-message-action-backdrop";
import {
  NativeMessagePresentationContext,
  NativeMessageDisclosureAuthorityContext,
  type NativeMessagePresentationDriver,
} from "@/components/user-message-native-presentation";
import {
  NativeMessageDisclosureSlot,
  requestNativeMessageDisclosure,
} from "@/components/user-message-native-flow";

type MessageProps = ComponentProps<typeof UserMessage>;
type Presentation = Partial<
  Pick<
    MessageProps,
    | "copyMask"
    | "previewLines"
    | "previewExpanded"
    | "bodyViewportHeight"
    | "pinned"
    | "actionRowBackdrop"
    | "onPreviewOverflowChange"
    | "inlineContentAction"
    | "contentAction"
    | "onContentPress"
    | "contentAccessibilityLabel"
  >
>;

const EXPANDED_DISCLOSURE = { expanded: true } as const;
const COLLAPSED_DISCLOSURE = { expanded: false } as const;

interface NativePromptDisclosureActionProps {
  driver: NativeMessagePresentationDriver;
  expanded: boolean;
}

/** The native gate owns availability; a queued React activation carries the
 * boundary token it received and cannot enroll itself into a newer handoff.
 */
function NativePromptDisclosureAction({ driver, expanded }: NativePromptDisclosureActionProps) {
  const authority = useContext(NativeMessageDisclosureAuthorityContext);
  const { t } = useTranslation();
  const toggle = useCallback(
    () =>
      requestNativeMessageDisclosure(driver, {
        ...authority,
        expected: expanded ? "compact" : "expanded",
        expanded,
      }),
    [driver, authority, expanded],
  );
  return (
    <Button
      variant="ghost"
      size="md"
      textStyle={styles.disclosureText}
      accessibilityLabel={t(expanded ? "stickyPrompt.expand" : "stickyPrompt.collapse")}
      accessibilityState={expanded ? COLLAPSED_DISCLOSURE : EXPANDED_DISCLOSURE}
      onPress={toggle}
      testID={expanded ? "user-message-disclosure" : "user-message-collapse"}
    >
      {t(expanded ? "stickyPrompt.more" : "stickyPrompt.less")}
    </Button>
  );
}

function useNativePromptDisclosure(
  driver: NativeMessagePresentationDriver | null,
  available: boolean,
) {
  const more = useMemo(
    () => (driver ? <NativePromptDisclosureAction driver={driver} expanded /> : null),
    [driver],
  );
  const less = useMemo(
    () => (driver ? <NativePromptDisclosureAction driver={driver} expanded={false} /> : null),
    [driver],
  );
  return useMemo(
    () =>
      driver && available ? (
        <NativeMessageDisclosureSlot driver={driver} more={more} less={less} />
      ) : null,
    [driver, available, more, less],
  );
}

function selectedPromptText(event: GestureResponderEvent): boolean {
  if (!isWeb) return false;
  const selection = window.getSelection();
  const target: unknown = event.currentTarget;
  return (
    !!selection &&
    !selection.isCollapsed &&
    target instanceof HTMLElement &&
    (target.contains(selection.anchorNode) || target.contains(selection.focusNode))
  );
}

function usePromptDisclosure(id: string, props: MessageProps) {
  const rows = useContext(ActualPromptRowsContext);
  const { t } = useTranslation();
  const expanded = rows?.expandedIds.has(id) ?? false;
  const [overflow, setOverflow] = useState({ text: props.message, hidden: false });
  const report = useCallback(
    (hidden: boolean) =>
      setOverflow((current) =>
        current.text === props.message && current.hidden === hidden
          ? current
          : { text: props.message, hidden },
      ),
    [props.message],
  );
  const toggle = useCallback(() => rows?.toggleExpanded(id), [rows, id]);
  const disclosureState = useMemo(() => ({ expanded }), [expanded]);
  const attachments = (props.images?.length ?? 0) + (props.attachments?.length ?? 0);
  const hiddenText = overflow.text === props.message && overflow.hidden;
  const action = useMemo(
    () =>
      rows && (expanded || hiddenText || attachments > 0) ? (
        <Button
          variant="ghost"
          size="md"
          textStyle={styles.disclosureText}
          accessibilityLabel={t(expanded ? "stickyPrompt.collapse" : "stickyPrompt.expand")}
          accessibilityState={disclosureState}
          aria-expanded={expanded}
          onPress={toggle}
          testID="user-message-disclosure"
        >
          {t(expanded ? "stickyPrompt.less" : "stickyPrompt.more")}
        </Button>
      ) : null,
    [rows, expanded, hiddenText, attachments, t, disclosureState, toggle],
  );
  return { expanded, report, action, available: expanded || hiddenText || attachments > 0 };
}

/** The shared renderer keeps the real body; this hook only supplies its policy. */
export function useActualPromptPresentation(id: string, props: MessageProps): Presentation {
  const rows = useContext(ActualPromptRowsContext);
  const pinned = useContext(ActualPinnedRowContext);
  const navigation = useContext(PromptNavigationContext);
  const disclosure = usePromptDisclosure(id, props);
  const nativeDriver = useContext(NativeMessagePresentationContext);
  const nativeDisclosure = useNativePromptDisclosure(nativeDriver, disclosure.available);
  const { t } = useTranslation();
  const backdrop = useMemo(() => <PinnedMessageActionBackdrop />, []);
  const reveal = useCallback(
    (event: GestureResponderEvent) => {
      if (!selectedPromptText(event)) navigation?.reveal(id);
    },
    [navigation, id],
  );
  if (!rows) return {};
  if (nativeDriver) {
    return {
      copyMask: undefined,
      // These nodes are prepared while ordinary. Android's UI owner alone
      // selects paint, controls, clipping and the full-row handoff boundary.
      previewLines: undefined,
      previewExpanded: true,
      bodyViewportHeight: undefined,
      pinned: false,
      actionRowBackdrop: backdrop,
      onPreviewOverflowChange: disclosure.report,
      inlineContentAction: nativeDisclosure,
      contentAction: undefined,
      onContentPress: reveal,
      contentAccessibilityLabel: t("stickyPrompt.goToMessage"),
    };
  }
  return {
    copyMask: undefined,
    // Ordinary history keeps its full body. Only the row currently pinned at
    // the viewport edge owns a compact preview and bounded sticky expansion.
    previewLines: pinned ? 1 : undefined,
    previewExpanded: !pinned || disclosure.expanded,
    bodyViewportHeight: pinned ? rows.bodyViewportHeight : undefined,
    pinned,
    actionRowBackdrop: pinned ? backdrop : undefined,
    // Discover overflow and prepare the real hidden control before the handoff.
    // WebUserMessageFlow keeps it outside flow, hidden and inert until bounded.
    onPreviewOverflowChange: isWeb || pinned ? disclosure.report : undefined,
    inlineContentAction: isWeb || pinned ? disclosure.action : null,
    contentAction: undefined,
    onContentPress: pinned ? reveal : props.onContentPress,
    contentAccessibilityLabel: pinned
      ? t("stickyPrompt.goToMessage")
      : props.contentAccessibilityLabel,
  };
}

const styles = StyleSheet.create((theme) => ({
  disclosureText: { color: theme.colors.userMessageForeground },
}));
