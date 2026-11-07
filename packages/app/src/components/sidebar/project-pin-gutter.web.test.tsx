/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPinGutterProvider, WorkspaceProjectPinGutter } from "./project-pin-gutter";

const PROJECT_PIN = { workspaceKey: "srv:project-pin", projectPinnedAt: "2026-10-16T00:00:00Z" };
const GLOBAL_PIN_ONLY = { workspaceKey: "srv:global-pin", projectPinnedAt: null };
const UNPINNED = { workspaceKey: "srv:ordinary", projectPinnedAt: null };

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function marker(workspaceKey: string): Element | null {
  return container!.querySelector(`[data-testid="sidebar-project-pin-icon-${workspaceKey}"]`);
}

async function renderGutters(enabled: boolean): Promise<void> {
  await act(() =>
    root?.render(
      <ProjectPinGutterProvider value={enabled}>
        <WorkspaceProjectPinGutter workspace={PROJECT_PIN} leadingSlot="status" />
        <WorkspaceProjectPinGutter workspace={GLOBAL_PIN_ONLY} leadingSlot="status" />
        <WorkspaceProjectPinGutter workspace={UNPINNED} leadingSlot="idle" />
      </ProjectPinGutterProvider>,
    ),
  );
}

describe("project pin gutter marker", () => {
  it("marks only project-pinned rows", async () => {
    await renderGutters(true);
    expect(marker("srv:project-pin")).not.toBeNull();
    expect(marker("srv:global-pin")).toBeNull();
    expect(marker("srv:ordinary")).toBeNull();
  });

  it("hides the marker while project pinning is off", async () => {
    await renderGutters(false);
    expect(marker("srv:project-pin")).toBeNull();
  });
});
