import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { View } from "react-native";
import { installWebOverlayPresentationGuard } from "@/lib/overlay-presentation";
import { Combobox } from "./combobox";

// Transition animations are outside this tooltip geometry and interaction regression.
vi.mock("react-native-reanimated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-reanimated")>();
  return {
    ...actual,
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
  };
});

const ADMISSION_ANCHOR_STYLE = { width: 200, height: 32 };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

it("admits the desktop combobox before its searchable autofocus content", async () => {
  await page.viewport(1200, 800);
  let admit!: (ready: boolean) => void;
  const release = vi.fn();
  const uninstall = installWebOverlayPresentationGuard(() => ({
    ready: new Promise<boolean>((resolve) => {
      admit = resolve;
    }),
    release,
  }));
  function Picker() {
    const anchor = React.useRef<View>(null);
    return (
      <>
        <View ref={anchor} style={ADMISSION_ANCHOR_STYLE} />
        <Combobox
          anchorRef={anchor}
          open
          value=""
          options={[{ id: "one", label: "One" }]}
          onSelect={vi.fn()}
          onOpenChange={vi.fn()}
          searchPlaceholder="Admission search"
        />
      </>
    );
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  try {
    act(() => root!.render(<Picker />));
    expect(document.querySelector('[data-testid="combobox-desktop-container"]')).toBeNull();
    expect(document.querySelector('[placeholder="Admission search"]')).toBeNull();
    await act(async () => {
      admit(true);
    });
    await expect
      .poll(() => document.querySelector('[data-testid="combobox-desktop-container"]'))
      .not.toBeNull();
    expect(document.querySelector('[placeholder="Admission search"]')).not.toBeNull();
    await act(async () => root!.render(null));
    expect(release).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root?.render(null));
    uninstall();
  }
});
