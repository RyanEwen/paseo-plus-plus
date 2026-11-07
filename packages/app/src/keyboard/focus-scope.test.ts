import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKeyboardControlTarget, resolveKeyboardFocusScope } from "./focus-scope";

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

/** Answers as a keyboard control for any selector, standing in for a button or ARIA control. */
class FakeControl extends FakeElement {
  override closest(): FakeElement {
    return this;
  }
}

describe("isKeyboardControlTarget", () => {
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

  it("detects a control and a target inside one", () => {
    const control = new FakeControl({ tagName: "button" });
    const icon = new FakeElement({ tagName: "span" });
    icon.parentElement = control;

    expect(isKeyboardControlTarget(control as unknown as EventTarget)).toBe(true);
    expect(isKeyboardControlTarget(icon as unknown as EventTarget)).toBe(true);
  });

  it("does not treat a neutral surface as a control", () => {
    const neutral = new FakeElement();

    expect(isKeyboardControlTarget(neutral as unknown as EventTarget)).toBe(false);
  });

  it("uses the focused control when the event target is not an element", () => {
    globalRef.document = { activeElement: new FakeControl({ tagName: "button" }) };

    expect(isKeyboardControlTarget(null)).toBe(true);
  });
});
