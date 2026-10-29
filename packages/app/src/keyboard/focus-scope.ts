import type { KeyboardFocusScope } from "@/keyboard/actions";

// Include ARIA controls because React Native Web pressables are not always native buttons.
const KEYBOARD_CONTROL_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "a[href]",
  "summary",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='combobox']",
  "[role='listbox']",
  "[role='slider']",
  "[role='spinbutton']",
  "[role='treeitem']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='scrollbar']",
].join(", ");

function isElement(value: unknown): value is Element {
  return typeof Element !== "undefined" && value instanceof Element;
}

function getFocusCandidateElements(target: EventTarget | null): Element[] {
  const candidates: Element[] = [];
  const pushUnique = (element: Element | null) => {
    if (!element || candidates.includes(element)) {
      return;
    }
    candidates.push(element);
  };

  if (isElement(target)) {
    pushUnique(target);
  }

  if (typeof Node !== "undefined" && target instanceof Node) {
    pushUnique(isElement(target.parentElement) ? target.parentElement : null);
  }

  if (typeof document !== "undefined" && isElement(document.activeElement)) {
    pushUnique(document.activeElement);
  }

  return candidates;
}

/** Detects controls, their descendants, and focused-control fallback for non-element targets. */
export function isKeyboardControlTarget(target: EventTarget | null): boolean {
  return getFocusCandidateElements(target).some((element) =>
    Boolean(element.closest(KEYBOARD_CONTROL_SELECTOR)),
  );
}

export function resolveKeyboardFocusScope(input: {
  target: EventTarget | null;
  commandCenterOpen: boolean;
}): KeyboardFocusScope {
  const { target, commandCenterOpen } = input;
  const candidates = getFocusCandidateElements(target);
  if (candidates.length === 0) {
    return commandCenterOpen ? "command-center" : "other";
  }

  if (
    candidates.some((element) =>
      Boolean(element.closest("[data-testid='terminal-surface']") || element.closest(".xterm")),
    )
  ) {
    return "terminal";
  }

  if (
    commandCenterOpen &&
    candidates.some((element) =>
      Boolean(
        element.closest("[data-testid='command-center-panel']") ||
        element.closest("[data-testid='command-center-input']"),
      ),
    )
  ) {
    return "command-center";
  }

  if (
    candidates.some((element) => Boolean(element.closest("[data-testid='message-input-root']")))
  ) {
    return "message-input";
  }

  if (
    candidates.some((element) => {
      const editable = element as HTMLElement;
      if (editable.isContentEditable) {
        return true;
      }
      const tag = element.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    })
  ) {
    return commandCenterOpen ? "command-center" : "editable";
  }

  return commandCenterOpen ? "command-center" : "other";
}
