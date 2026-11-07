/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@/i18n/resources/en";
import type {
  DesktopBrowserExtensionAction,
  DesktopBrowserExtensionsBridge,
} from "@/desktop/host";
import { ExtensionsMenu } from "./extensions-menu.electron";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: "en", fallbackLng: "en", resources: { en: { translation: en } } });
});

afterEach(cleanup);

beforeEach(() => vi.stubGlobal("React", React));

const triggerStyle = () => ({});
const tooltipTextStyle = {};

/** Render extension controls through the same query and translation providers in every toolbar test. */
function extensionMenus(
  client: QueryClient,
  browserIds: string[],
  bridge: DesktopBrowserExtensionsBridge,
) {
  return (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        {browserIds.map((browserId) => (
          <ExtensionsMenu
            key={browserId}
            browserId={browserId}
            triggerStyle={triggerStyle}
            tooltipTextStyle={tooltipTextStyle}
            bridge={bridge}
          />
        ))}
      </I18nextProvider>
    </QueryClientProvider>
  );
}

it("pins an extension across panes and routes each toolbar action to its own browser", async () => {
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
  const bridge: DesktopBrowserExtensionsBridge = {
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
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(extensionMenus(client, ["first", "second"], bridge));
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
  }
});

it("keeps extension icons stable and scopes busy state to the pending toolbar action", async () => {
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
  const bridge: DesktopBrowserExtensionsBridge = {
    list: async () => [],
    actions: async () => rows,
    openPopup: popup,
    setPinned: async () => {},
    onChanged: () => () => {},
    setEnabled: async () => {},
    remove: async () => {},
    loadUnpacked: async () => {},
    openStore: async () => {},
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(extensionMenus(client, ["pending-browser"], bridge));
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
  }
});

it("updates extension badges per browser without replacing icons and keeps complete accessible text", async () => {
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
  const bridge: DesktopBrowserExtensionsBridge = {
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
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(extensionMenus(client, ["first", "second"], bridge));
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
    view.rerender(extensionMenus(client, ["third", "second"], bridge));
    expect(await view.findByRole("button", { name: "Badge fixture (3)" })).not.toBeNull();
    expect(view.getByRole("button", { name: "Badge fixture (2)" })).not.toBeNull();
    expect(actions).toHaveBeenCalledWith("first");
    expect(actions).toHaveBeenCalledWith("second");
    expect(actions).toHaveBeenCalledWith("third");
  } finally {
    view.unmount();
    client.clear();
  }
});
