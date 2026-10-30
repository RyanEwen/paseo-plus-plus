// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import * as React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseSync, transformFromAstSync, traverse, types } from "@babel/core";
import type {
  UserMessageFlowProps,
  useNaturalMessageMeasurements,
} from "../components/user-message-flow";
import type { NativeMessagePresentationDriver } from "../components/user-message-native-presentation";
import {
  readMessageTextLayout,
  rebindMessageTextPrefix,
  resolveMessageFlow,
} from "../components/user-message-flow-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import { useStreamHistoryWindow } from "./use-stream-history-window";

function message(id: string, kind: "user_message" | "assistant_message"): StreamItem {
  return { id, kind, text: id, timestamp: new Date() };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS");
});

describe("useStreamHistoryWindow", () => {
  it("mounts only the most recent 20 items by default", () => {
    const items = Array.from({ length: 11 }, (_, turn) => [
      message(`u${turn}`, "user_message"),
      message(`a${turn}`, "assistant_message"),
    ]).flat();

    const { result } = renderHook(() =>
      useStreamHistoryWindow({ agentId: "agent-1", items, loadRemoteOlder: vi.fn() }),
    );

    expect(result.current.start).toBe(2);
  });

  it("reveals loaded history before requesting an older daemon page", async () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const loadRemoteOlder = vi.fn(async () => true);
    const { result } = renderHook(() =>
      useStreamHistoryWindow({
        agentId: "agent-1",
        items: [
          message("u1", "user_message"),
          message("a1", "assistant_message"),
          message("u2", "user_message"),
          message("a2", "assistant_message"),
        ],
        loadRemoteOlder,
      }),
    );

    expect(result.current.start).toBe(2);
    await act(async () => result.current.loadOlder());
    expect(result.current.start).toBe(0);
    expect(loadRemoteOlder).not.toHaveBeenCalled();

    await act(async () => result.current.loadOlder());
    expect(loadRemoteOlder).toHaveBeenCalledOnce();
  });

  it("keeps remotely prepended rows visible after all local history was revealed", async () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const items = [
      message("u1", "user_message"),
      message("a1", "assistant_message"),
      message("u2", "user_message"),
      message("a2", "assistant_message"),
    ];
    const loadRemoteOlder = vi.fn(async () => true);
    const { result, rerender } = renderHook(
      ({ history }) =>
        useStreamHistoryWindow({
          agentId: "agent-1",
          items: history,
          loadRemoteOlder,
        }),
      { initialProps: { history: items } },
    );
    expect(result.current.start).toBe(2);
    await act(async () => result.current.loadOlder());
    expect(result.current.start).toBe(0);
    expect(result.current.hasLocalHistory).toBe(false);
    expect(loadRemoteOlder).not.toHaveBeenCalled();

    await act(async () => result.current.loadOlder());
    expect(loadRemoteOlder).toHaveBeenCalledOnce();
    const prepended = [message("u0", "user_message"), message("a0", "assistant_message"), ...items];
    rerender({ history: prepended });

    // The accepted remote page enters the already fully revealed ordinary window.
    expect(result.current.start).toBe(0);
    expect(result.current.hasLocalHistory).toBe(false);
    expect(prepended.slice(result.current.start).map((item) => item.id)).toEqual([
      "u0",
      "a0",
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
    expect(prepended[2]).toBe(items[0]);
    expect(prepended[3]).toBe(items[1]);
    expect(loadRemoteOlder).toHaveBeenCalledOnce();
  });

  it("keeps its boundary at the same item when loaded history is prepended", () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const items = [
      message("u1", "user_message"),
      message("a1", "assistant_message"),
      message("u2", "user_message"),
      message("a2", "assistant_message"),
    ];
    const { result, rerender } = renderHook(
      ({ history }) =>
        useStreamHistoryWindow({ agentId: "agent-1", items: history, loadRemoteOlder: vi.fn() }),
      { initialProps: { history: items } },
    );

    expect(result.current.start).toBe(2);
    rerender({
      history: [message("u0", "user_message"), message("a0", "assistant_message"), ...items],
    });
    expect(result.current.start).toBe(4);
  });

  it("keeps live appends inside the rendered window", () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const items = [
      message("u1", "user_message"),
      message("a1", "assistant_message"),
      message("u2", "user_message"),
      message("a2", "assistant_message"),
    ];
    const { result, rerender } = renderHook(
      ({ history }) =>
        useStreamHistoryWindow({ agentId: "agent-1", items: history, loadRemoteOlder: vi.fn() }),
      { initialProps: { history: items } },
    );

    rerender({
      history: [...items, message("u3", "user_message"), message("a3", "assistant_message")],
    });
    expect(result.current.start).toBe(2);
  });

  it("restarts at a recent window when an item replacement removes the boundary", () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const { result, rerender } = renderHook(
      ({ history }) =>
        useStreamHistoryWindow({ agentId: "agent-1", items: history, loadRemoteOlder: vi.fn() }),
      {
        initialProps: {
          history: [
            message("u1", "user_message"),
            message("a1", "assistant_message"),
            message("u2", "user_message"),
            message("a2", "assistant_message"),
          ],
        },
      },
    );

    rerender({
      history: [
        message("new-u1", "user_message"),
        message("new-a1", "assistant_message"),
        message("new-u2", "user_message"),
        message("new-a2", "assistant_message"),
        message("new-u3", "user_message"),
        message("new-a3", "assistant_message"),
      ],
    });
    expect(result.current.start).toBe(4);
  });

  it("does not claim to reveal a missing or already-visible item", () => {
    Object.defineProperty(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", {
      value: 2,
      configurable: true,
    });
    const { result } = renderHook(() =>
      useStreamHistoryWindow({
        agentId: "agent-1",
        items: [
          message("u1", "user_message"),
          message("a1", "assistant_message"),
          message("u2", "user_message"),
          message("a2", "assistant_message"),
        ],
        loadRemoteOlder: vi.fn(),
      }),
    );

    expect(result.current.revealLoadedHistory("missing")).toBe(false);
    expect(result.current.revealLoadedHistory("u2")).toBe(false);
  });
});

describe("native natural measurement revisions", () => {
  type Measurements = ReturnType<typeof useNaturalMessageMeasurements>;
  interface HookProps extends Pick<UserMessageFlowProps, "message" | "revision" | "controls"> {
    driver: Pick<NativeMessagePresentationDriver, "binding">;
  }

  /** Read the same source declarations used by the native renderer, without
   * importing its UI modules or replacing its measurement/revision algorithms.
   */
  function sourceFunctions(relative: string, names: readonly string[]) {
    const filename = fileURLToPath(new URL(relative, import.meta.url));
    const ast = parseSync(readFileSync(filename, "utf8"), {
      filename,
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: ["typescript", "jsx"] },
    });
    if (!ast) throw new Error("Production measurement source did not parse");
    const selected: types.FunctionDeclaration[] = [];
    traverse(ast, {
      FunctionDeclaration(candidate) {
        if (candidate.node.id && names.includes(candidate.node.id.name)) {
          selected.push(types.cloneNode(candidate.node, true));
        }
      },
    });
    return names.map((name) => {
      const matches = selected.filter((declaration) => declaration.id?.name === name);
      if (matches.length !== 1 || !matches[0]) throw new Error("Production hook is not unique");
      return matches[0];
    });
  }

  /** Preserve the actual NativeUserMessageFlow prefix through measurements.
   * Real React owns every hook. Only the device font-scale input is controlled;
   * native frame/text callbacks are driven through the actual returned methods.
   */
  function loadMeasurementHook(
    readDimensions: () => { fontScale: number },
  ): (props: HookProps) => Measurements {
    const native = sourceFunctions("../components/user-message-native-flow.tsx", [
      "nativePresentationDriver",
      "NativeUserMessageFlow",
    ]);
    const component = native[1];
    if (!component) throw new Error("Production measurement prefix is missing");
    const index = component.body.body.findIndex(
      (statement) =>
        types.isVariableDeclaration(statement) &&
        statement.declarations.some((declaration) =>
          types.isIdentifier(declaration.id, { name: "measurements" }),
        ),
    );
    if (index < 0) throw new Error("Production measurement call is missing");
    component.body.body = [
      ...component.body.body.slice(0, index + 1),
      types.returnStatement(types.identifier("measurements")),
    ];
    const natural = sourceFunctions("../components/user-message-flow.tsx", [
      "emptyMeasurements",
      "sameFrame",
      "useNaturalMessageMeasurements",
    ]);
    const require = createRequire(import.meta.url);
    const filename = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../components/user-message-native-flow.tsx",
    );
    const compiled = transformFromAstSync(
      types.file(types.program([...natural, ...native])),
      undefined,
      {
        filename,
        babelrc: false,
        configFile: false,
        plugins: [[require.resolve("@babel/plugin-transform-typescript"), { isTSX: true }]],
      },
    );
    if (!compiled?.code) throw new Error("Production measurement source did not compile");
    const bindings = {
      useMemo: React.useMemo,
      useState: React.useState,
      useRef: React.useRef,
      useCallback: React.useCallback,
      useLayoutEffect: React.useLayoutEffect,
      useWindowDimensions: readDimensions,
      readMessageTextLayout,
      rebindMessageTextPrefix,
    };
    const loaded: unknown = new Function(
      ...Object.keys(bindings),
      `${compiled.code}\nreturn NativeUserMessageFlow;`,
    )(...Object.values(bindings));
    if (typeof loaded !== "function") throw new Error("Production measurement hook did not bind");
    return (props) => Reflect.apply(loaded, undefined, [props]);
  }

  /** Supply actual natural-frame reports, including the initially empty More
   * slot, before exercising a presentation-only or genuine geometry transition.
   */
  function seedNaturalMeasurements(current: () => Measurements) {
    act(() => current().setWidth(320));
    act(() => {
      const value = current();
      value.reportHeight("bodyHeight", 300);
      value.reportHeight("trailingHeight", 40);
      value.reportFrame("bubble", { x: 60, y: 0, width: 260, height: 300 });
      value.reportFrame("content", { x: 16, y: 16, width: 228, height: 268 });
      value.reportFrame("controls", { x: 0, y: 0, width: 0, height: 0 });
      value.reportFrame("text", { x: 0, y: 0, width: 228, height: 172 });
      value.reportText([
        { y: 0, height: 20, width: 200 },
        { y: 24, height: 20, width: 210 },
        { y: 48, height: 20, width: 180 },
      ]);
    });
  }

  const initialProps: HookProps = {
    message: "A full multiline prompt",
    revision: {},
    controls: null,
    driver: { binding: 17 },
  };

  it("retains the full natural extent when initial overflow discovery adds the More slot", () => {
    const useMeasurements = loadMeasurementHook(() => ({ fontScale: 1 }));
    const { result, rerender } = renderHook((props: HookProps) => useMeasurements(props), {
      initialProps,
    });
    seedNaturalMeasurements(() => result.current);
    const key = result.current.key;
    expect(
      resolveMessageFlow({ measurements: result.current.metrics, hasText: true })?.flowHeight,
    ).toBe(340);

    rerender({ ...initialProps, controls: React.createElement("span", null, "More") });

    expect(
      resolveMessageFlow({ measurements: result.current.metrics, hasText: true })?.flowHeight,
    ).toBe(340);
    expect(result.current.key === key).toBe(true);
    expect(result.current.metrics.bodyHeight).toBe(300);
  });

  it("retains natural measurements when only the same-binding driver object changes", () => {
    const useMeasurements = loadMeasurementHook(() => ({ fontScale: 1 }));
    const { result, rerender } = renderHook((props: HookProps) => useMeasurements(props), {
      initialProps,
    });
    seedNaturalMeasurements(() => result.current);
    const key = result.current.key;

    rerender({ ...initialProps, driver: { binding: 17 } });

    expect(
      resolveMessageFlow({ measurements: result.current.metrics, hasText: true })?.flowHeight,
    ).toBe(340);
    expect(result.current.key === key).toBe(true);
  });

  it.each(["content", "width", "font", "binding"])(
    "invalidates natural measurements for a genuine %s change",
    (change) => {
      const dimensions = { fontScale: 1 };
      const useMeasurements = loadMeasurementHook(() => dimensions);
      const { result, rerender } = renderHook((props: HookProps) => useMeasurements(props), {
        initialProps,
      });
      seedNaturalMeasurements(() => result.current);
      const key = result.current.key;

      if (change === "width") {
        act(() => result.current.setWidth(280));
      } else if (change === "font") {
        dimensions.fontScale = 1.25;
        rerender(initialProps);
      } else if (change === "binding") {
        rerender({ ...initialProps, driver: { binding: 18 } });
      } else {
        rerender({ ...initialProps, message: "A changed prompt", revision: {} });
      }

      expect(result.current.key === key).toBe(false);
      expect(result.current.metrics.bodyHeight).toBeNull();
      expect(
        resolveMessageFlow({ measurements: result.current.metrics, hasText: true }),
      ).toBeNull();
    },
  );
});
