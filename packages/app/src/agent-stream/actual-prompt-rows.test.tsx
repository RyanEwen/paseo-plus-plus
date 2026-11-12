// @vitest-environment jsdom

import {
  ActualPinnedRowContext,
  ActualPromptRowsContext,
  ActualPromptRowsProvider,
} from "./actual-prompt-rows";
import { useActualPromptPresentation } from "./use-actual-prompt-presentation";
import React, { useContext, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStickyPrompt } from "./use-sticky-prompt";
import { stickyInput, stickyOutline, stickyUser } from "./chat-outline/sticky-prompt.test-fixture";

describe("actual prompt disclosure ownership", () => {
  beforeEach(() => vi.stubGlobal("React", React));
  afterEach(() => vi.unstubAllGlobals());
  it("reveals the clicked actual row rather than a different current selection", () => {
    const first = stickyUser("first", 1);
    const latest = stickyUser("latest", 3);
    const input = stickyInput([first, latest], stickyOutline([1, 3]));
    const { result } = renderHook(useStickyPrompt, { initialProps: input });
    expect(result.current.message?.id).toBe("latest");
    act(() => result.current.reveal("first"));
    expect(input.jumpToLoaded).toHaveBeenCalledExactlyOnceWith("first", "original");
    expect(result.current.message?.id).toBe("first");
    expect(input.outline.jumpToPrompt).not.toHaveBeenCalled();
  });

  it("retains expansion through row unmount and clears it across epoch changes without remounting the owner", () => {
    let scope = "session:epoch-1";
    const prepare = vi.fn();
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ActualPromptRowsProvider enabled scope={scope} availableHeight={500}>
          {children}
        </ActualPromptRowsProvider>
      );
    }
    const { result, rerender } = renderHook(() => useContext(ActualPromptRowsContext), {
      wrapper: Wrapper,
    });
    let release: (() => void) | undefined;
    act(() => {
      release = result.current!.registerViewport(prepare);
    });
    act(() => result.current!.toggleExpanded("original"));
    expect(prepare).toHaveBeenCalledExactlyOnceWith("original");
    expect(result.current!.expandedIds.has("original")).toBe(true);
    rerender();
    expect(result.current!.expandedIds.has("original")).toBe(true);
    scope = "session:epoch-2";
    rerender();
    expect(result.current!.expandedIds.size).toBe(0);
    scope = "session:epoch-1";
    rerender();
    expect(result.current!.expandedIds.size).toBe(0);
    act(() => release?.());
  });

  it("keeps a pending submission's expansion through the draft handoff and the epoch's arrival", () => {
    // The created agent takes over the draft's timeline: the scope changes twice while the
    // submitted row keeps its client message id.
    let scope = "server:tab_draft:pending";
    let established = false;
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ActualPromptRowsProvider
          enabled
          scope={scope}
          established={established}
          availableHeight={500}
        >
          {children}
        </ActualPromptRowsProvider>
      );
    }
    const { result, rerender } = renderHook(() => useContext(ActualPromptRowsContext), {
      wrapper: Wrapper,
    });
    const submitted = "draft_msg_1:initial-message";
    act(() => result.current!.toggleExpanded(submitted));
    expect(result.current!.expandedIds.has(submitted)).toBe(true);

    scope = "server:agent-1:pending";
    rerender();
    expect(result.current!.expandedIds.has(submitted)).toBe(true);

    scope = "server:agent-1:epoch-1";
    established = true;
    rerender();
    expect(result.current!.expandedIds.has(submitted)).toBe(true);

    // A replaced epoch still starts collapsed.
    scope = "server:agent-1:epoch-2";
    rerender();
    expect(result.current!.expandedIds.size).toBe(0);
  });

  it("keeps ordinary messages expanded independently of sticky disclosure across pin transitions", () => {
    let pinned = false;
    const attachments = [
      { type: "text" as const, mimeType: "text/plain" as const, text: "Attachment body" },
    ];
    const props = { message: "First line\nSecond line\nThird line", timestamp: 0, attachments };
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ActualPromptRowsProvider enabled scope="session:epoch" availableHeight={500}>
          <ActualPinnedRowContext.Provider value={pinned}>
            {children}
          </ActualPinnedRowContext.Provider>
        </ActualPromptRowsProvider>
      );
    }
    const { result, rerender } = renderHook(
      () => ({
        presentation: useActualPromptPresentation("original", props),
        rows: useContext(ActualPromptRowsContext),
      }),
      { wrapper: Wrapper },
    );
    expect(result.current.presentation.previewLines).toBeUndefined();
    expect(result.current.presentation.previewExpanded).toBe(true);
    expect(result.current.presentation.bodyViewportHeight).toBeUndefined();
    // Web prepares this real control for measurement; ordinary clipping and
    // inaccessible paint are covered through the actual WebUserMessageFlow suite.
    expect(React.isValidElement(result.current.presentation.inlineContentAction)).toBe(true);
    expect(result.current.presentation.inlineContentAction).toEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          testID: "user-message-disclosure",
          "aria-expanded": false,
        }),
      }),
    );
    expect(result.current.presentation.onPreviewOverflowChange).toEqual(expect.any(Function));
    expect(result.current.rows!.expandedIds.has("original")).toBe(false);

    pinned = true;
    rerender();
    expect(result.current.presentation.previewLines).toBe(1);
    expect(result.current.presentation.previewExpanded).toBe(false);
    expect(result.current.presentation.bodyViewportHeight).toBe(
      result.current.rows!.bodyViewportHeight,
    );
    expect(React.isValidElement(result.current.presentation.inlineContentAction)).toBe(true);
    act(() => result.current.rows!.toggleExpanded("original"));
    expect(result.current.presentation.previewExpanded).toBe(true);

    pinned = false;
    rerender();
    expect(result.current.presentation.previewLines).toBeUndefined();
    expect(result.current.presentation.bodyViewportHeight).toBeUndefined();
    expect(React.isValidElement(result.current.presentation.inlineContentAction)).toBe(true);
    expect(result.current.presentation.inlineContentAction).toEqual(
      expect.objectContaining({
        props: expect.objectContaining({
          testID: "user-message-disclosure",
          "aria-expanded": true,
        }),
      }),
    );
    act(() => result.current.rows!.toggleExpanded("original"));
    expect(result.current.rows!.expandedIds.has("original")).toBe(false);
    expect(result.current.presentation.previewExpanded).toBe(true);
    expect(props.attachments.length).toBe(1);
    expect(props.attachments[0]!.text).toBe("Attachment body");

    pinned = true;
    rerender();
    expect(result.current.presentation.previewExpanded).toBe(false);
    expect(result.current.presentation.previewLines).toBe(1);
  });

  it("provides no collapse or pin policy when the feature is disabled", () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ActualPromptRowsProvider enabled={false} scope="session:epoch" availableHeight={500}>
          {children}
        </ActualPromptRowsProvider>
      );
    }
    const { result } = renderHook(() => useContext(ActualPromptRowsContext), { wrapper: Wrapper });
    expect(result.current).toBeNull();
  });
});
