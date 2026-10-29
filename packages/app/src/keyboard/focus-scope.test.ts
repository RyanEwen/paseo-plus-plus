// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isKeyboardControlTarget, resolveKeyboardFocusScope } from "./focus-scope";
import {
  buildEffectiveBindings,
  resolveKeyboardShortcut,
  type ShortcutOverrides,
} from "./keyboard-shortcuts";
import { createKeyboardActionDispatcher } from "./keyboard-action-dispatcher";
import { routeKeyboardShortcut } from "./route-shortcut";
import { runMessageInputKeyboardAction } from "@/composer/input/state";

class FakeNode {
  parentElement: FakeElement | null = null;
}

class FakeElement extends FakeNode {
  tagName: string;
  isContentEditable = false;
  private selectors: Set<string>;

  constructor(input?: { tagName?: string; selectors?: string[]; isContentEditable?: boolean }) {
    super();
    this.tagName = (input?.tagName ?? "div").toUpperCase();
    this.selectors = new Set(input?.selectors ?? []);
    if (input?.isContentEditable) {
      this.isContentEditable = true;
    }
  }

  closest(selector: string): FakeElement | null {
    if (this.selectors.has(selector)) {
      return this;
    }
    return this.parentElement?.closest(selector) ?? null;
  }
}

describe("resolveKeyboardFocusScope", () => {
  const globalRef = globalThis as {
    Element?: unknown;
    Node?: unknown;
    document?: { activeElement?: unknown };
  };
  const originalElement = globalRef.Element;
  const originalNode = globalRef.Node;
  const originalDocument = globalRef.document;

  beforeEach(() => {
    globalRef.Element = FakeElement;
    globalRef.Node = FakeNode;
    globalRef.document = { activeElement: null };
  });

  afterEach(() => {
    globalRef.Element = originalElement;
    globalRef.Node = originalNode;
    globalRef.document = originalDocument;
  });

  it("resolves terminal scope from the direct keyboard event target", () => {
    const target = new FakeElement({ selectors: [".xterm"] });
    const scope = resolveKeyboardFocusScope({
      target: target as unknown as EventTarget,
      commandCenterOpen: false,
    });
    expect(scope).toBe("terminal");
  });

  it("falls back to activeElement when target is not an Element", () => {
    const activeElement = new FakeElement({ selectors: [".xterm"] });
    globalRef.document = { activeElement };
    const scope = resolveKeyboardFocusScope({
      target: null,
      commandCenterOpen: false,
    });
    expect(scope).toBe("terminal");
  });

  it("detects editable scope from activeElement fallback", () => {
    const activeElement = new FakeElement({ tagName: "input" });
    globalRef.document = { activeElement };
    const scope = resolveKeyboardFocusScope({
      target: null,
      commandCenterOpen: false,
    });
    expect(scope).toBe("editable");
  });
});

describe("focused controls through shortcut resolution and composer dispatch", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  /** Runs the owning chain without mounting the application or replacing its action handlers. */
  function dispatchKey(input: {
    target: EventTarget | null;
    isRealtimeVoiceActive: boolean;
    key?: string;
    code?: string;
    ctrlKey?: boolean;
    overrides?: ShortcutOverrides;
  }) {
    const toggleRealtimeVoiceMute = vi.fn();
    const dispatcher = createKeyboardActionDispatcher();
    dispatcher.registerHandler({
      handlerId: "composer",
      actions: ["message-input.voice-mute-toggle"],
      enabled: true,
      priority: 0,
      handle: () =>
        runMessageInputKeyboardAction("voice-mute-toggle", {
          focusInput: () => undefined,
          isDictationRecording: () => false,
          markTranscriptForSend: () => undefined,
          startDictation: () => undefined,
          confirmDictation: () => undefined,
          cancelDictation: () => undefined,
          toggleRealtimeVoice: () => undefined,
          isRealtimeVoiceActive: input.isRealtimeVoiceActive,
          toggleRealtimeVoiceMute,
        }),
    });
    const resolution = resolveKeyboardShortcut({
      event: {
        key: input.key ?? " ",
        code: input.code ?? "Space",
        altKey: false,
        ctrlKey: input.ctrlKey ?? false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
      },
      context: {
        isMac: false,
        isDesktop: true,
        commandCenterOpen: false,
        focusScope: resolveKeyboardFocusScope({ target: input.target, commandCenterOpen: false }),
        interactiveControlFocused: isKeyboardControlTarget(input.target),
      },
      chordState: { candidateIndices: [], step: 0, timeoutId: null },
      onChordReset: () => undefined,
      bindings: buildEffectiveBindings(input.overrides ?? {}),
    });
    let handled = false;
    if (resolution.match) {
      const action = routeKeyboardShortcut(resolution.match, {
        pathname: "/h/srv/workspace/ws",
        isMobile: false,
        sidebarShortcutTargets: [],
        navigationActiveWorkspace: null,
        commandCenterOpen: false,
        shortcutsDialogOpen: false,
      });
      if (action.kind === "dispatch") {
        handled = dispatcher.dispatch(action.action);
      }
    }
    return { resolution, handled, toggleRealtimeVoiceMute };
  }

  it.each([
    '<button tabindex="0">Disclosure</button>',
    '<button tabindex="0"><span data-target>Disclosure icon</span></button>',
    '<div role="button" tabindex="0">Filter</div>',
    '<div role="button" tabindex="0"><span data-target>Filter icon</span></div>',
    '<a href="#target" tabindex="0">Link</a>',
    '<input type="checkbox" tabindex="0">',
    '<div role="checkbox" tabindex="0">Checkbox</div>',
    '<div role="switch" tabindex="0">Switch</div>',
    '<div role="slider" tabindex="0">Slider</div>',
    '<summary tabindex="0">Details</summary>',
  ])("preserves Space on %s while voice is active", (markup) => {
    document.body.innerHTML = markup;
    const control = document.body.firstElementChild;
    if (!(control instanceof HTMLElement)) {
      throw new Error("Expected a focusable control");
    }
    control.focus();
    const target = control.querySelector("[data-target]") ?? control;
    const { resolution, handled, toggleRealtimeVoiceMute } = dispatchKey({
      target,
      isRealtimeVoiceActive: true,
    });
    expect(resolution.match).toBeNull();
    expect(resolution.preventDefault).toBe(false);
    expect(handled).toBe(false);
    expect(toggleRealtimeVoiceMute).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(control);
  });

  it("handles a modified voice override on a focused button and protects an explicit bare-Space override", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const { resolution, handled, toggleRealtimeVoiceMute } = dispatchKey({
      target: button,
      isRealtimeVoiceActive: true,
      key: "m",
      code: "KeyM",
      ctrlKey: true,
      overrides: { "message-input-voice-mute-toggle": "Ctrl+M" },
    });
    expect(resolution.match?.payload).toEqual({ kind: "voice-mute-toggle" });
    expect(handled).toBe(true);
    expect(resolution.match?.preventDefault).toBe(true);
    expect(resolution.match?.stopPropagation).toBe(true);
    expect(toggleRealtimeVoiceMute).toHaveBeenCalledTimes(1);

    const bareSpace = dispatchKey({
      target: button,
      isRealtimeVoiceActive: true,
      overrides: { "message-input-voice-mute-toggle": "Space" },
    });
    expect(bareSpace.resolution.match).toBeNull();
    expect(bareSpace.resolution.preventDefault).toBe(false);
    expect(bareSpace.handled).toBe(false);
    expect(bareSpace.toggleRealtimeVoiceMute).not.toHaveBeenCalled();
  });

  it("uses the focused control when the event target is not an element", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const { resolution, handled } = dispatchKey({ target: null, isRealtimeVoiceActive: true });
    expect(resolution.match).toBeNull();
    expect(handled).toBe(false);
  });

  it.each([false, true])(
    "handles neutral-surface Space only with active voice (%s)",
    (isRealtimeVoiceActive) => {
      const neutral = document.createElement("div");
      neutral.tabIndex = 0;
      document.body.append(neutral);
      neutral.focus();
      const { resolution, handled, toggleRealtimeVoiceMute } = dispatchKey({
        target: neutral,
        isRealtimeVoiceActive,
      });
      expect(resolution.match?.payload).toEqual({ kind: "voice-mute-toggle" });
      expect(handled).toBe(isRealtimeVoiceActive);
      expect(toggleRealtimeVoiceMute).toHaveBeenCalledTimes(Number(isRealtimeVoiceActive));
    },
  );

  it.each([
    '<input tabindex="0">',
    '<textarea tabindex="0"></textarea>',
    '<div contenteditable="true" tabindex="0">Text</div>',
    '<div data-testid="message-input-root"><textarea tabindex="0"></textarea></div>',
    '<div data-testid="terminal-surface"><textarea tabindex="0"></textarea></div>',
  ])("keeps Space available to existing text and terminal scopes: %s", (markup) => {
    document.body.innerHTML = markup;
    const target = document.querySelector("[tabindex]");
    const { resolution, handled } = dispatchKey({ target, isRealtimeVoiceActive: true });
    expect(resolution.match).toBeNull();
    expect(handled).toBe(false);
  });

  it("retains the existing Enter shortcut on focused buttons", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const { resolution } = dispatchKey({
      target: button,
      isRealtimeVoiceActive: true,
      key: "Enter",
      code: "Enter",
    });
    expect(resolution.match?.payload).toEqual({ kind: "dictation-confirm" });
  });
});
