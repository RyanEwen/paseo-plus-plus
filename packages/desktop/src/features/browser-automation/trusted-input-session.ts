import {
  BrowserInputTimeoutError,
  createInputLifetime,
  type TrustedInputPage,
} from "./input-lifetime.js";
import {
  fail,
  isScreenshotNoFrameError,
  PIXEL_CAPTURE_TIMEOUT_MS,
  waitForPaint,
  withDialogCapture,
  type AutomationCommandPayload,
  type FailurePayload,
  type TabContents,
} from "./service.js";

// Fork-owned trusted input orchestration, kept out of the upstream command service.

interface FocusInputTargetOptions {
  page: Pick<TabContents, "executeJavaScript">;
  /** Page expression that resolves the exact ref element. */
  elementExpression: string;
  /** Refuse targets that cannot accept typed text (type requires this; keypress does not). */
  requiresEditable?: boolean;
}

/** Focus inside the guest without the pointer gesture that transfers host DOM focus.
 * Revalidate after synchronous focus handlers, before native input. This does not make
 * later page scripts and the separate native input message an atomic operation.
 * Contenteditable input focuses its editing host and keeps an existing exact-ref selection.
 */
export async function focusInputTarget({
  page,
  elementExpression,
  requiresEditable = false,
}: FocusInputTargetOptions): Promise<"focused" | "stale_ref" | "not_focused"> {
  const result = await page.executeJavaScript(String.raw`(() => {
    const resolveElement = () => (${elementExpression});
    const element = resolveElement();
    const connectedHere = (node) =>
      node?.isConnected &&
      node.ownerDocument === document &&
      node.getRootNode() === document;
    if (!connectedHere(element)) return { staleRef: true };
    const editingHostFor = () => {
      let host = element;
      while (host.isContentEditable && host.parentElement?.isContentEditable) host = host.parentElement;
      return host;
    };
    const editingHost = editingHostFor();
    const selectionWithin = (selection) =>
      Boolean(selection?.rangeCount) &&
      element.contains(selection.anchorNode) &&
      element.contains(selection.focusNode);
    const selection = element.isContentEditable ? document.getSelection() : null;
    const retainedSelection = selectionWithin(selection) ? {
      anchor: selection.anchorNode, anchorOffset: selection.anchorOffset,
      focus: selection.focusNode, focusOffset: selection.focusOffset,
    } : null;
    const stillCurrent = () =>
      connectedHere(element) &&
      connectedHere(editingHost) &&
      resolveElement() === element &&
      editingHostFor() === editingHost;
    if (typeof editingHost.focus !== 'function') return { focused: false };
    editingHost.focus({ preventScroll: true });
    if (!stillCurrent()) return { staleRef: true };
    const tagName = element.tagName ? element.tagName.toLowerCase() : '';
    const inputType = tagName === 'input' ? String(element.getAttribute('type') || 'text').toLowerCase() : '';
    const editableInput = tagName === 'textarea' ||
      (tagName === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType));
    const editable = editableInput || element.isContentEditable === true;
    const disabled =
      element.disabled ||
      element.closest('[aria-disabled="true"], fieldset[disabled]');
    const notEditable =
      ${JSON.stringify(requiresEditable)} &&
      (!editable || element.readOnly);
    if (disabled || notEditable) return { focused: false };
    if (element.isContentEditable) {
      const currentSelection = document.getSelection();
      if (document.activeElement !== editingHost || !currentSelection) return { focused: false };
      if (retainedSelection) {
        if (!element.contains(retainedSelection.anchor) || !element.contains(retainedSelection.focus)) {
          return { focused: false };
        }
        const { anchor, anchorOffset, focus, focusOffset } = retainedSelection;
        const selectionMoved =
          currentSelection.anchorNode !== anchor ||
          currentSelection.anchorOffset !== anchorOffset ||
          currentSelection.focusNode !== focus ||
          currentSelection.focusOffset !== focusOffset;
        if (selectionMoved) {
          currentSelection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
        }
      } else {
        // WebDriver Send Keys initializes a contenteditable caret after its child content.
        // Use the exact ref subtree, never another selection in the surrounding editing host.
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        currentSelection.removeAllRanges();
        currentSelection.addRange(range);
      }
      if (!stillCurrent()) return { staleRef: true };
      return { focused: document.activeElement === editingHost && selectionWithin(currentSelection) };
    }
    return { focused: document.activeElement === element };
  })()`);
  if (!result || typeof result !== "object") {
    return "stale_ref";
  }
  const record = result as Record<string, unknown>;
  if (record.staleRef === true) {
    return "stale_ref";
  }
  return record.focused === true ? "focused" : "not_focused";
}

/** Refuse native input when a page handler redirected focus or disabled the original target. */
export function inputFocusFailure(requestId: string): FailurePayload {
  return fail(requestId, "browser_unsupported", "Browser input target did not retain focus.");
}

interface TrustedInputOperation {
  requestId: string;
  contents: TabContents;
  task: (page: TrustedInputPage) => Promise<AutomationCommandPayload>;
}

/** Keep this guest producing frames only while trusted input is in flight.
 * Hidden Chromium input waits for compositor acknowledgments; the adapter
 * shares the scope with screenshots and restores policy after the last user.
 */
export async function withTrustedInput({
  requestId,
  contents,
  task,
}: TrustedInputOperation): Promise<AutomationCommandPayload> {
  const lifetime = createInputLifetime(contents);

  async function performInput(): Promise<AutomationCommandPayload> {
    const inputUrl = contents.getURL();
    const documentChanged = () =>
      contents.isDestroyed() || contents.isLoading() || contents.getURL() !== inputUrl;
    const result = await task(lifetime.page);
    if (!result.ok || documentChanged()) return result;

    // Wheel acknowledgments can precede animation-aligned event dispatch.
    try {
      await waitForPaint(lifetime.page, Date.now() + PIXEL_CAPTURE_TIMEOUT_MS);
    } catch (error) {
      // A delivered click/key may close or navigate the document while its
      // final animation callback is pending. Preserve that input result.
      if (documentChanged()) return result;
      if (!isScreenshotNoFrameError(error)) throw error;
      return fail(
        result.requestId,
        "browser_timeout",
        "Timed out waiting for the browser input frame. Input may already have been delivered.",
      );
    }
    return result;
  }

  const capture = () =>
    withDialogCapture(contents, { task: performInput, signal: lifetime.signal });
  const produceFrames = () => {
    lifetime.assertActive();
    if (contents.isDestroyed()) {
      return Promise.resolve(fail(requestId, "browser_tab_closed", "Browser tab has been closed"));
    }
    return contents.withFrameProduction(() => lifetime.wait(capture));
  };
  try {
    return await contents.runInput(produceFrames, lifetime.signal);
  } catch (error) {
    if (contents.isDestroyed()) {
      return fail(requestId, "browser_tab_closed", "Browser tab has been closed");
    }
    if (!(error instanceof BrowserInputTimeoutError)) throw error;
    // The broker must not treat an uncertain delivered action as safe to replay.
    // A command that timed out before sending any input delivered nothing.
    if (!lifetime.dispatched) {
      return fail(
        requestId,
        "browser_timeout",
        "Browser input timed out before it was sent. Retry the command.",
        true,
      );
    }
    return fail(requestId, "browser_timeout", error.message);
  } finally {
    lifetime.dispose();
  }
}
