/**
 * @vitest-environment jsdom
 */
import React, { createRef, useMemo } from "react";
import { cleanup, fireEvent, render, act, waitFor } from "@testing-library/react";
import { Text, type View } from "react-native";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PageZoomMenu } from "@/desktop/browser/pane/page-zoom-menu.electron";
import {
  ensureResidentBrowserWebview,
  clearResidentBrowserWebviewsForTests,
} from "@/desktop/browser/resident-webviews";
import { ExtensionsMenu } from "@/desktop/browser/pane/extensions-menu.electron";
import type { DesktopBrowserExtensionAction } from "@/desktop/host";
import { MenuRoot, MenuTrigger } from "./menu-root";
import { MenuItem } from "./menu-item";
import { useMenuContext } from "./menu-context";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@/i18n/resources/en";

const pickerI18n = createInstance();
beforeAll(async () => {
  await pickerI18n.init({ lng: "en", fallbackLng: "en", resources: { en: { translation: en } } });
});

afterEach(cleanup);

beforeEach(() => vi.stubGlobal("React", React));

describe("MenuTrigger", () => {
  it("forwards its rendered trigger to callers", () => {
    const triggerRef = createRef<View>();

    render(
      <MenuRoot>
        <MenuTrigger ref={triggerRef} accessibilityLabel="Open menu">
          <Text>Open</Text>
        </MenuTrigger>
      </MenuRoot>,
    );

    expect(triggerRef.current).not.toBeNull();
  });
});

function MenuOpenState() {
  const { open } = useMenuContext("MenuOpenState");
  return <Text>{open ? "open" : "closed"}</Text>;
}
function CreationRow({ create, split }: { create: () => void; split: () => void }) {
  const secondary = useMemo(
    () => (
      <MenuItem iconOnly accessibilityLabel="Choose split" onSelect={split} closeOnSelect={false} />
    ),
    [split],
  );
  return (
    <MenuItem onSelect={create} secondaryAction={secondary}>
      Create view
    </MenuItem>
  );
}
it("keeps a menu row's split control separate from its primary creation action", () => {
  const create = vi.fn();
  const split = vi.fn();
  const view = render(
    <MenuRoot defaultOpen>
      <CreationRow create={create} split={split} />
      <MenuOpenState />
    </MenuRoot>,
  );
  const primary = view.getByRole("menuitem", { name: "Create view" });
  const secondary = view.getByRole("menuitem", { name: "Choose split" });
  expect(primary.contains(secondary)).toBe(false);
  fireEvent.click(secondary);
  expect(split).toHaveBeenCalledTimes(1);
  expect(create).not.toHaveBeenCalled();
  expect(view.getByText("open")).toBeTruthy();
  fireEvent.click(primary);
  expect(create).toHaveBeenCalledTimes(1);
  expect(view.getByText("closed")).toBeTruthy();
});

const extensionTriggerStyle = () => ({});
const extensionTooltipStyle = {};
/** Render extension controls through the same query and translation providers in every toolbar test. */
function extensionMenus(client: QueryClient, browserIds: string[]) {
  return (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={pickerI18n}>
        {browserIds.map((browserId) => (
          <ExtensionsMenu
            key={browserId}
            browserId={browserId}
            triggerStyle={extensionTriggerStyle}
            tooltipTextStyle={extensionTooltipStyle}
          />
        ))}
      </I18nextProvider>
    </QueryClientProvider>
  );
}

it("pins an extension across panes and routes each toolbar action to its own browser", async () => {
  const original = window.paseoDesktop;
  const listeners = new Set<() => void>();
  const rows: DesktopBrowserExtensionAction[] = [
    {
      id: "a".repeat(32),
      name: "Fixture extension",
      title: "Open fixture",
      iconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      pinned: false,
      hasPopup: true,
    },
  ];
  rows.push({
    id: "b".repeat(32),
    name: "Background extension",
    title: "Background extension",
    iconDataUrl: null,
    pinned: false,
    hasPopup: false,
  });
  let failPin = true;
  const popup = vi.fn(async () => {});
  window.paseoDesktop = {
    browser: {
      extensions: {
        list: async () => [],
        actions: async () => rows.map((row) => ({ ...row })),
        openPopup: popup,
        setPinned: async (id, pinned) => {
          if (failPin) throw new Error("Pin storage unavailable");
          const row = rows.find((entry) => entry.id === id);
          if (!row) throw new Error("Missing extension");
          row.pinned = pinned;
          for (const listener of listeners) listener();
        },
        onChanged: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        setEnabled: async () => {},
        remove: async () => {},
        loadUnpacked: async () => {},
        openStore: async () => {},
      },
    },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(extensionMenus(client, ["first", "second"]));
  try {
    fireEvent.click(view.getAllByRole("button", { name: "Extensions" })[0]);
    fireEvent.click(await view.findByRole("menuitem", { name: "Pin Fixture extension" }));
    expect(await view.findByText("Pin storage unavailable")).not.toBeNull();
    expect(view.queryAllByRole("button", { name: "Fixture extension" })).toHaveLength(0);
    failPin = false;
    fireEvent.click(view.getByRole("menuitem", { name: "Pin Fixture extension" }));
    await waitFor(() =>
      expect(view.getAllByRole("button", { name: "Fixture extension" })).toHaveLength(2),
    );
    expect(view.getByRole("menuitem", { name: "Unpin Fixture extension" })).not.toBeNull();
    fireEvent.click(view.getAllByRole("button", { name: "Fixture extension" })[1]);
    await waitFor(() => expect(popup).toHaveBeenCalledExactlyOnceWith("a".repeat(32), "second"));
    fireEvent.click(view.getByRole("menuitem", { name: "Unpin Fixture extension" }));
    await waitFor(() =>
      expect(view.queryAllByRole("button", { name: "Fixture extension" })).toHaveLength(0),
    );
    fireEvent.click(view.getByRole("menuitem", { name: "Pin Background extension" }));
    await waitFor(() =>
      expect(view.getAllByRole("button", { name: "Background extension" })).toHaveLength(2),
    );
    for (const button of view.getAllByRole("button", { name: "Background extension" }))
      expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(popup).toHaveBeenCalledTimes(1);
    rows.pop();
    act(() => {
      for (const listener of listeners) listener();
    });
    await waitFor(() =>
      expect(view.queryAllByRole("button", { name: "Background extension" })).toHaveLength(0),
    );
  } finally {
    view.unmount();
    client.clear();
    window.paseoDesktop = original;
  }
});

it("reads guest page zoom on open, changes and resets it without changing application zoom", async () => {
  const guest = ensureResidentBrowserWebview({
    browserId: "menu-zoom",
    workspaceId: "workspace",
    url: "https://example.com",
    profileHost: { profilePartition: "persist:test-zoom", registerAttachedBrowser: async () => {} },
  });
  if (!guest) throw new Error("Expected fixture guest");
  let zoom = 1.25;
  const nativeSet = vi.fn((factor: number) => {
    zoom = factor;
  });
  Object.defineProperties(guest, {
    getZoomFactor: { value: () => zoom },
    setZoomFactor: { value: nativeSet },
  });
  const getWebview = vi.fn(() => guest);
  const view = render(
    <I18nextProvider i18n={pickerI18n}>
      <PageZoomMenu
        browserId="menu-zoom"
        getWebview={getWebview}
        triggerStyle={extensionTriggerStyle}
        tooltipTextStyle={extensionTooltipStyle}
      />
    </I18nextProvider>,
  );
  try {
    const trigger = view.getByRole("button", { name: "Page zoom" });
    expect(trigger.style.minWidth).toBe("48px");
    fireEvent.click(trigger);
    fireEvent.click(await view.findByRole("menuitem", { name: "150%" }));
    expect(nativeSet).toHaveBeenLastCalledWith(1.5);
    expect(zoom).toBe(1.5);
    fireEvent.click(view.getByRole("menuitem", { name: "100%" }));
    expect(nativeSet).toHaveBeenLastCalledWith(1);
    expect(nativeSet).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    clearResidentBrowserWebviewsForTests();
  }
});

it("keeps extension icons stable and scopes busy state to the pending toolbar action", async () => {
  const original = window.paseoDesktop;
  let rejectPopup: (error: Error) => void = () => {
    throw new Error("Popup not started");
  };
  const popup = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectPopup = reject;
      }),
  );
  const rows: DesktopBrowserExtensionAction[] = [
    {
      id: "a".repeat(32),
      name: "Pending fixture",
      title: "Open fixture",
      hasPopup: true,
      pinned: true,
      iconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    },
  ];
  window.paseoDesktop = {
    browser: {
      extensions: {
        list: async () => [],
        actions: async () => rows,
        openPopup: popup,
        setPinned: async () => {},
        onChanged: () => () => {},
        setEnabled: async () => {},
        remove: async () => {},
        loadUnpacked: async () => {},
        openStore: async () => {},
      },
    },
  } as unknown as Window["paseoDesktop"];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(extensionMenus(client, ["pending-browser"]));
  try {
    const pinned = await view.findByRole("button", { name: "Pending fixture" });
    const generic = view.getByRole("button", { name: "Extensions" });
    const icon = pinned.querySelector("img");
    expect(icon).not.toBeNull();
    const genericMarkup = generic.innerHTML;
    fireEvent.click(pinned);
    await waitFor(() => expect(pinned.getAttribute("aria-busy")).toBe("true"));
    expect(pinned.getAttribute("aria-disabled")).toBe("true");
    expect(pinned.querySelector("img")).toBe(icon);
    expect(generic.innerHTML).toBe(genericMarkup);
    expect(generic.getAttribute("aria-busy")).not.toBe("true");
    expect(view.queryByRole("progressbar")).toBeNull();
    await act(async () => rejectPopup(new Error("Fixture popup unavailable")));
    expect(await view.findByText("Fixture popup unavailable")).not.toBeNull();
    expect(pinned.getAttribute("aria-busy")).toBe("false");
    expect(pinned.getAttribute("aria-disabled")).not.toBe("true");
    expect(pinned.querySelector("img")).toBe(icon);
    expect(popup).toHaveBeenCalledExactlyOnceWith("a".repeat(32), "pending-browser");
  } finally {
    view.unmount();
    client.clear();
    window.paseoDesktop = original;
  }
});

it("updates extension badges per browser without replacing icons and keeps complete accessible text", async () => {
  const original = window.paseoDesktop;
  const listeners = new Set<() => void>();
  const texts: Record<string, string> = { first: "12", second: "2", third: "3" };
  const actions = vi.fn(
    async (browserId: string): Promise<DesktopBrowserExtensionAction[]> => [
      {
        id: "a".repeat(32),
        name: "Badge fixture",
        title: "Badge fixture",
        pinned: true,
        hasPopup: true,
        iconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        badge: { text: texts[browserId], backgroundColor: [255, 255, 255, 255], textColor: null },
      },
    ],
  );
  window.paseoDesktop = {
    browser: {
      extensions: {
        list: async () => [],
        actions,
        openPopup: async () => {},
        setPinned: async () => {},
        onChanged: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        setEnabled: async () => {},
        remove: async () => {},
        loadUnpacked: async () => {},
        openStore: async () => {},
      },
    },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(extensionMenus(client, ["first", "second"]));
  try {
    const first = await view.findByRole("button", { name: "Badge fixture (12)" });
    expect(await view.findByRole("button", { name: "Badge fixture (2)" })).not.toBeNull();
    const icon = first.querySelector("img");
    expect(icon).not.toBeNull();
    texts.first = "123456";
    act(() => {
      for (const listener of listeners) listener();
    });
    const updated = await view.findByRole("button", { name: "Badge fixture (123456)" });
    expect(updated).toBe(first);
    expect(updated.querySelector("img")).toBe(icon);
    expect(view.getByText("1234")).not.toBeNull();
    fireEvent.click(view.getAllByRole("button", { name: "Extensions" })[0]);
    expect(await view.findByRole("menuitem", { name: "Badge fixture (123456)" })).not.toBeNull();
    fireEvent.click(view.getAllByRole("button", { name: "Extensions" })[0]);
    texts.first = "";
    act(() => {
      for (const listener of listeners) listener();
    });
    expect(await view.findByRole("button", { name: "Badge fixture" })).toBe(first);
    expect(view.queryByText("1234")).toBeNull();
    view.rerender(extensionMenus(client, ["third", "second"]));
    expect(await view.findByRole("button", { name: "Badge fixture (3)" })).not.toBeNull();
    expect(view.getByRole("button", { name: "Badge fixture (2)" })).not.toBeNull();
    expect(actions).toHaveBeenCalledWith("first");
    expect(actions).toHaveBeenCalledWith("second");
    expect(actions).toHaveBeenCalledWith("third");
  } finally {
    view.unmount();
    client.clear();
    window.paseoDesktop = original;
  }
});
