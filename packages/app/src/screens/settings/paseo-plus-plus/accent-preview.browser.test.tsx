import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccentPreview } from "./accent-preview";

const MESSAGE = "This is how your messages will look";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("React", React);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** The preview only demonstrates bubble colors, so it must not carry conversation chrome. */
it("shows only the sample text, with no timestamp or message actions", () => {
  act(() => root.render(<AccentPreview message={MESSAGE} />));

  const preview = container.querySelector('[data-testid="accent-message-preview"]');
  expect(preview?.textContent).toBe(MESSAGE);
  expect(preview?.querySelectorAll("button, [role='button']")).toHaveLength(0);
});
