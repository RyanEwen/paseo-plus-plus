/** @vitest-environment jsdom */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import { installSettingsSyncSaveHandler } from "@/settings-sync/save-handler";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NewTabLauncherProvider,
  useWorkspaceTabLaunchCatalog,
  type WorkspaceTabLaunchGroup,
} from "../index";

const fixture = vi.hoisted(() => ({ enabled: true, readReady: false, mounts: 0, unmounts: 0 }));
const registrations: (() => void)[] = [];
const queryClients: QueryClient[] = [];
vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({
    settings: { paseoPlusPlus: { previousAgents: fixture.enabled } },
    isReadReady: fixture.readReady,
  }),
}));
vi.mock("@/components/reopen-closed-agent-dialog", async () => {
  const { useEffect } = await import("react");
  return {
    ReopenClosedAgentDialog: () => {
      useEffect(() => {
        fixture.mounts += 1;
        return () => {
          fixture.unmounts += 1;
        };
      }, []);
      return null;
    },
  };
});
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("lucide-react-native", () => ({
  Globe: () => null,
  History: () => null,
  SquarePen: () => null,
  SquareTerminal: () => null,
}));
vi.mock("@/hooks/use-daemon-config", () => ({ useDaemonConfig: () => ({ config: {} }) }));
vi.mock("@/plugins/icons", () => ({ resolvePluginIcon: vi.fn() }));
vi.mock("@/plugins/registry", () => ({ useInstalledPlugins: () => [] }));
vi.mock("@/panels/register-panels", () => ({ ensurePanelsRegistered: vi.fn() }));
vi.mock("@/panels/panel-manifest", () => ({
  panelCanLaunchInPane: () => true,
  panelSupportsHost: () => true,
}));
vi.mock("@/panels/panel-registry", () => ({
  getPanelRegistration: () => ({ presentation: { label: () => "Panel", icon: () => null } }),
}));
afterEach(() => {
  cleanup();
  for (const registration of registrations.splice(0)) registration();
  for (const client of queryClients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

/** Flatten the shared catalog exactly as compact menus consume it. */
function flattenCatalog(groups: readonly WorkspaceTabLaunchGroup[]) {
  return groups.flatMap((group) => group.items);
}
import { getBuiltInLaunchOrder } from "./catalog";

describe("getBuiltInLaunchOrder", () => {
  it("leads with creating work in a primary pane", () => {
    expect(getBuiltInLaunchOrder("primary")).toEqual([
      "agent",
      "terminal",
      "changes",
      "diff",
      "files",
      "browser",
      "pullRequest",
    ]);
  });

  it("leads with companion tools in a supporting pane", () => {
    expect(getBuiltInLaunchOrder("supporting")).toEqual([
      "changes",
      "terminal",
      "diff",
      "files",
      "agent",
      "browser",
      "pullRequest",
    ]);
  });
});

describe("previous agent launcher preference", () => {
  it("hides every catalog surface and dismisses the dialog without launching sessions", () => {
    vi.stubGlobal("React", React);
    fixture.enabled = true;
    fixture.readReady = false;
    const client = new QueryClient();
    queryClients.push(client);
    const registration = installSettingsSyncSaveHandler(async () => false);
    registrations.push(registration);
    client.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS);
    fixture.mounts = 0;
    fixture.unmounts = 0;
    const launch = vi.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(NewTabLauncherProvider, {
          value: {
            serverId: "host",
            workspaceId: "workspace",
            showChanges: true,
            showPullRequest: true,
            showBrowser: true,
            terminalDisabled: false,
            launch,
          },
          // This existing .ts suite uses createElement rather than JSX.
          // eslint-disable-next-line react/no-children-prop
          children,
        }),
      );
    const { result, rerender } = renderHook(
      () => {
        const menu = useWorkspaceTabLaunchCatalog({
          serverId: "host",
          purpose: "primary",
          host: "main",
          surface: "menu",
        });
        const panel = useWorkspaceTabLaunchCatalog({
          serverId: "host",
          purpose: "supporting",
          host: "main",
          surface: "panel",
        });
        return {
          menu: flattenCatalog(menu),
          panel: flattenCatalog(panel),
        };
      },
      { wrapper },
    );
    // Default On stays hidden until the selected settings authority is known.
    expect(result.current.menu.some((item) => item.id === "reopen-closed-agent")).toBe(false);
    expect(result.current.panel.some((item) => item.id === "reopen-closed-agent")).toBe(false);
    expect(fixture.mounts).toBe(0);
    registration.updateReadAvailability({ hydrated: true, generation: 1, status: "ready" });
    fixture.readReady = true;
    rerender();
    const previous = result.current.menu.find((item) => item.id === "reopen-closed-agent")!;
    act(() => previous.launch({ kind: "open" }));
    expect(fixture.mounts).toBe(1);
    fixture.enabled = false;
    client.setQueryData(APP_SETTINGS_QUERY_KEY, {
      ...DEFAULT_CLIENT_SETTINGS,
      paseoPlusPlus: { ...DEFAULT_CLIENT_SETTINGS.paseoPlusPlus, previousAgents: false },
    });
    rerender();
    expect(result.current.menu.some((item) => item.id === "reopen-closed-agent")).toBe(false);
    expect(result.current.panel.some((item) => item.id === "reopen-closed-agent")).toBe(false);
    expect(result.current.menu.some((item) => item.id === "agent")).toBe(true);
    expect(fixture.unmounts).toBe(1);
    // A menu action captured before the preference change cannot resurrect the dialog.
    act(() => previous.launch({ kind: "open" }));
    fixture.enabled = true;
    client.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS);
    rerender();
    expect(fixture.mounts).toBe(1);
    expect(result.current.menu.some((item) => item.id === "reopen-closed-agent")).toBe(true);
    const restored = result.current.menu.find((item) => item.id === "reopen-closed-agent")!;
    act(() => restored.launch({ kind: "open" }));
    expect(fixture.mounts).toBe(2);
    expect(launch).not.toHaveBeenCalled();

    // The same retained action observes real authority/cache transitions before rerender.
    fixture.readReady = false;
    registration.updateReadAvailability({ hydrated: true, generation: 2, status: "reading" });
    rerender();
    expect(fixture.unmounts).toBe(2);
    act(() => restored.launch({ kind: "open" }));
    registration.updateReadAvailability({ hydrated: true, generation: 2, status: "readonly" });
    fixture.readReady = true;
    rerender();
    expect(fixture.mounts).toBe(2);
    client.setQueryData(APP_SETTINGS_QUERY_KEY, {
      ...DEFAULT_CLIENT_SETTINGS,
      paseoPlusPlus: { ...DEFAULT_CLIENT_SETTINGS.paseoPlusPlus, previousAgents: false },
    });
    act(() => restored.launch({ kind: "open" }));
    client.setQueryData(APP_SETTINGS_QUERY_KEY, DEFAULT_CLIENT_SETTINGS);
    rerender();
    expect(fixture.mounts).toBe(2);
    const available = result.current.menu.find((item) => item.id === "reopen-closed-agent")!;
    act(() => available.launch({ kind: "open" }));
    expect(fixture.mounts).toBe(3);
    expect(launch).not.toHaveBeenCalled();
  });
});
