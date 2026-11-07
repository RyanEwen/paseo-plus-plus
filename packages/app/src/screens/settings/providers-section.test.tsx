/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import type { ToastApi } from "@/components/toast-host";
const clipboardMock = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock("expo-clipboard", () => ({ setStringAsync: clipboardMock }));

const { theme, snapshotState, configState, patchConfigMock, openProviderSettingsMock } = vi.hoisted(
  () => ({
    theme: {
      spacing: { 1: 4, "1.5": 6, 2: 8, 3: 12, 4: 16, 6: 24 },
      iconSize: { sm: 14, md: 20 },
      fontSize: { xs: 11, sm: 13, base: 15 },
      fontWeight: { normal: "400" },
      borderRadius: { lg: 8 },
      opacity: { 50: 0.5 },
      colors: {
        surface1: "#111",
        surface2: "#222",
        surface3: "#333",
        foreground: "#fff",
        foregroundMuted: "#aaa",
        border: "#555",
        accent: "#0a84ff",
        statusSuccess: "#00ff00",
        statusWarning: "#ff9500",
        statusDanger: "#ff0000",
        palette: { red: { 300: "#ff6b6b" }, white: "#fff" },
      },
    },
    snapshotState: {
      entries: undefined as ProviderSnapshotEntry[] | undefined,
      isLoading: false,
      isRefreshing: false,
    },
    configState: {
      config: null as MutableDaemonConfig | null,
    },
    patchConfigMock: vi.fn(async () => undefined),
    openProviderSettingsMock: vi.fn(),
  }),
);

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Pressable: ({
    children,
    onPress,
    onHoverIn,
    onHoverOut,
    accessibilityRole,
    accessibilityLabel,
    disabled,
    testID,
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
    onPress?: (event: React.MouseEvent) => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      {
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "aria-disabled": disabled ? "true" : undefined,
        "data-testid": testID,
        onClick: disabled ? undefined : onPress,
        onMouseEnter: onHoverIn,
        onMouseLeave: onHoverOut,
      },
      typeof children === "function" ? children({ pressed: false, hovered: false }) : children,
    ),
  ActivityIndicator: () => React.createElement("span", { "data-testid": "activity-indicator" }),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    ChevronRight: icon("ChevronRight"),
    Copy: icon("Copy"),
    MoreHorizontal: icon("MoreHorizontal"),
    Trash2: icon("Trash2"),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      (
        ({
          "settings.providers.providerDetails": "{{name}} provider details",
          "settings.providers.enableProvider": "Enable {{name}}",
          "settings.providers.statuses.disabled": "Disabled",
          "settings.providers.statuses.available": "Available",
          "settings.providers.statuses.loading": "Loading",
          "settings.providers.statuses.error": "Error",
          "settings.providers.statuses.notInstalled": "Not installed",
          "settings.providers.models.one": "1 model",
          "settings.providers.models.many": "{{count}} models",
          "settings.providers.addErrorTitle": "Unable to add provider",
          "settings.providers.updateErrorTitle": "Unable to update provider",
          "settings.providers.actions.menu": "{{name}} actions",
          "settings.providers.actions.remove": "Remove provider",
          "settings.providers.actions.removing": "Removing...",
          "settings.providers.actions.copyMigrationPrompt": "Copy migration prompt",
          "settings.providers.actions.migrationPrompt": "migration prompt",
          "settings.providers.actions.copying": "Copying...",
          "settings.providers.actions.copyFailed": "Couldn't copy migration prompt",
          "settings.providers.remove.confirmTitle": "Remove {{name}}?",
          "settings.providers.remove.confirmMessage":
            "This deletes the provider entry from config.json. It cannot be undone.",
          "settings.providers.remove.confirm": "Remove",
          "settings.providers.remove.errorTitle": "Unable to remove provider",
        })[key] ?? key
      )
        .replaceAll("{{name}}", String(values?.name ?? ""))
        .replaceAll("{{count}}", String(values?.count ?? "")),
  }),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    disabled,
    accessibilityLabel,
    testID,
  }: {
    value: boolean;
    onValueChange?: (next: boolean) => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement("div", {
      role: "switch",
      "aria-checked": value ? "true" : "false",
      "aria-disabled": disabled ? "true" : undefined,
      "aria-label": accessibilityLabel,
      "data-testid": testID ?? "provider-switch",
      onClick: (event: React.MouseEvent) => {
        event.stopPropagation();
        if (disabled) return;
        onValueChange?.(!value);
      },
    }),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { "data-testid": "loading-spinner" }),
}));

vi.mock("@/components/settings/headings/settings-info-tip", () => ({
  SettingsInfoTip: () => null,
}));

vi.mock("@/components/ui/external-link", () => ({
  ExternalLink: () => null,
  ExternalLinkLabel: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuTrigger: ({
    children,
    onPressIn,
    accessibilityRole,
    accessibilityLabel,
    testID,
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean; open: boolean }) => React.ReactNode);
    onPressIn?: (event: { stopPropagation: () => void }) => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        onMouseDown: (event: React.MouseEvent) => onPressIn?.(event),
        onClick: (event: React.MouseEvent) => event.stopPropagation(),
      },
      typeof children === "function"
        ? children({ pressed: false, hovered: false, open: false })
        : children,
    ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    status,
    pendingLabel,
    testID,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    status?: "idle" | "pending" | "success";
    pendingLabel?: string;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        disabled: status === "pending" || status === "success",
        onClick: (event: React.MouseEvent) => {
          event.stopPropagation();
          onSelect?.();
        },
      },
      status === "pending" ? pendingLabel : children,
    ),
}));

vi.mock("@/components/provider-icons", () => ({
  useProviderIcon: (provider: string) => () =>
    React.createElement("span", { "data-icon": `provider-${provider}` }),
}));

vi.mock("@/stores/provider-settings-store", () => ({
  useProviderSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ open: openProviderSettingsMock }),
}));

vi.mock("@/components/provider-catalog-list", () => ({
  ProviderCatalogList: () => null,
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: snapshotState.entries,
    isLoading: snapshotState.isLoading,
    isFetching: false,
    isRefreshing: snapshotState.isRefreshing,
    error: null,
    supportsSnapshot: true,
    refresh: vi.fn(async () => {}),
    refetchIfStale: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: configState.config,
    isLoading: false,
    patchConfig: patchConfigMock,
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => false,
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: vi.fn(async () => true),
}));

import { ProvidersSection } from "./providers-section";

function unexpectedToast(): never {
  throw new Error("Provider row interactions should not display a toast");
}

const toastApi: ToastApi = {
  show: unexpectedToast,
  copied: unexpectedToast,
  error: unexpectedToast,
};

const claudeEntry: ProviderSnapshotEntry = {
  provider: "claude",
  status: "ready",
  enabled: true,
  label: "Claude",
  description: "Claude Code",
  defaultModeId: null,
  modes: [],
  models: [
    { provider: "claude", id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { provider: "claude", id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { provider: "claude", id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

const disabledCodexEntry: ProviderSnapshotEntry = {
  provider: "codex",
  status: "unavailable",
  enabled: false,
  label: "Codex",
  description: "OpenAI Codex",
  defaultModeId: null,
  modes: [],
};

function makeConfig(providers: MutableDaemonConfig["providers"] = {}): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers,
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
}

function descendants(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>("*"));
}

function indexOfMatches(nodes: HTMLElement[], selector: string): number {
  return nodes.findIndex((node) => node.matches(selector));
}

function indexOfText(nodes: HTMLElement[], text: string): number {
  return nodes.findIndex((node) => node.textContent?.trim() === text);
}

describe("ProvidersSection", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    snapshotState.entries = undefined;
    snapshotState.isLoading = false;
    snapshotState.isRefreshing = false;
    configState.config = null;
    patchConfigMock.mockReset();
    patchConfigMock.mockResolvedValue(undefined);
    openProviderSettingsMock.mockReset();
    clipboardMock.mockReset();
    clipboardMock.mockResolvedValue(true);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function render(): void {
    act(() => {
      root?.render(
        <ToastApiProvider api={toastApi}>
          <ProvidersSection serverId="server-1" />
        </ToastApiProvider>,
      );
    });
  }

  function findRow(accessibilityLabel: string): HTMLElement {
    const row = container?.querySelector<HTMLElement>(
      `[role="button"][aria-label="${accessibilityLabel}"]`,
    );
    if (!row) throw new Error(`Expected row with aria-label "${accessibilityLabel}"`);
    return row;
  }

  it("copies generic migration guidance for a built-in provider without executing or inspecting configuration", async () => {
    const copied = vi.spyOn(toastApi, "copied").mockImplementation(() => {});
    snapshotState.entries = [{ ...claudeEntry, label: "private-label" }];
    configState.config = makeConfig();
    Object.defineProperty(configState.config, "privateAuth", {
      get: () => {
        throw new Error("must not read auth");
      },
    });
    render();
    const button = container!.querySelector<HTMLButtonElement>(
      '[data-testid="provider-copy-migration-prompt-claude"]',
    )!;
    expect(button.textContent).toBe("Copy migration prompt");
    await act(async () => button.click());
    expect(clipboardMock).toHaveBeenCalledTimes(1);
    const prompt = clipboardMock.mock.calls[0][0];
    expect(prompt).toContain('"provider": "claude"');
    expect(prompt).toContain('"inventoryPerformed": false');
    expect(prompt).toContain('"source": null');
    expect(prompt).toContain('"destination": null');
    expect(prompt).not.toContain("private-label");
    expect(copied).toHaveBeenCalledWith("migration prompt");
    expect(patchConfigMock).not.toHaveBeenCalled();
    expect(openProviderSettingsMock).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-testid="provider-remove-claude"]')).toBeNull();
  });

  it("shows pending copy and success only after clipboard resolves", async () => {
    const copied = vi.spyOn(toastApi, "copied").mockImplementation(() => {});
    let finish!: (value: boolean) => void;
    clipboardMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    snapshotState.entries = [disabledCodexEntry];
    configState.config = makeConfig();
    render();
    const button = container!.querySelector<HTMLButtonElement>(
      '[data-testid="provider-copy-migration-prompt-codex"]',
    )!;
    act(() => button.click());
    expect(button.textContent).toBe("Copying...");
    expect(button.disabled).toBe(true);
    expect(copied).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(button.disabled).toBe(false);
    expect(copied).toHaveBeenCalledTimes(1);
  });

  it.each(["rejection", "false"])(
    "reports clipboard %s and permits retry without provider actions",
    async (failure) => {
      const error = vi.spyOn(toastApi, "error").mockImplementation(() => {});
      const copied = vi.spyOn(toastApi, "copied").mockImplementation(() => {});
      if (failure === "rejection")
        clipboardMock.mockRejectedValueOnce(new Error("private-platform-error"));
      else clipboardMock.mockResolvedValueOnce(false);
      snapshotState.entries = [claudeEntry];
      configState.config = makeConfig();
      render();
      const button = container!.querySelector<HTMLButtonElement>(
        '[data-testid="provider-copy-migration-prompt-claude"]',
      )!;
      await act(async () => button.click());
      expect(error).toHaveBeenCalledWith("Couldn't copy migration prompt");
      expect(copied).not.toHaveBeenCalled();
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
      expect(copied).toHaveBeenCalledTimes(1);
      expect(patchConfigMock).not.toHaveBeenCalled();
      expect(openProviderSettingsMock).not.toHaveBeenCalled();
    },
  );

  it("renders the disabled provider with its server-provided label in snapshot order", () => {
    snapshotState.entries = [claudeEntry, disabledCodexEntry];
    configState.config = makeConfig({ codex: { enabled: false } });

    render();

    const rows = Array.from(
      container?.querySelectorAll<HTMLElement>('[role="button"][aria-label$="provider details"]') ??
        [],
    );
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Claude provider details",
      "Codex provider details",
    ]);

    const codexRow = findRow("Codex provider details");
    const codexNodes = descendants(codexRow);
    expect(indexOfText(codexNodes, "Codex")).toBeGreaterThanOrEqual(0);
    expect(indexOfText(codexNodes, "codex")).toBe(-1);
    expect(indexOfText(codexNodes, "Disabled")).toBeGreaterThanOrEqual(0);
  });

  it("composes the row as chevron, icon, label, status, model count, then switch", () => {
    snapshotState.entries = [claudeEntry];
    configState.config = makeConfig();

    render();

    const row = findRow("Claude provider details");
    const nodes = descendants(row);
    const chevron = indexOfMatches(nodes, '[data-icon="ChevronRight"]');
    const icon = indexOfMatches(nodes, '[data-icon="provider-claude"]');
    const label = indexOfText(nodes, "Claude");
    const status = indexOfText(nodes, "Available");
    const modelCount = indexOfText(nodes, "3 models");
    const switchEl = indexOfMatches(nodes, '[role="switch"]');

    expect(chevron).toBeGreaterThanOrEqual(0);
    expect(icon).toBeGreaterThan(chevron);
    expect(label).toBeGreaterThan(icon);
    expect(status).toBeGreaterThan(label);
    expect(modelCount).toBeGreaterThan(status);
    expect(switchEl).toBeGreaterThan(modelCount);
  });

  it("opens the diagnostic sheet when the outer row is pressed for a disabled provider", () => {
    snapshotState.entries = [disabledCodexEntry];
    configState.config = makeConfig({ codex: { enabled: false } });

    render();

    expect(openProviderSettingsMock).not.toHaveBeenCalled();

    const row = findRow("Codex provider details");
    act(() => {
      row.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(openProviderSettingsMock).toHaveBeenCalledTimes(1);
    expect(openProviderSettingsMock).toHaveBeenCalledWith({
      serverId: "server-1",
      provider: "codex",
    });
  });

  it("toggles the provider enabled flag through patchConfig when the switch is pressed", async () => {
    snapshotState.entries = [claudeEntry];
    configState.config = makeConfig();

    render();

    const row = findRow("Claude provider details");
    const switchEl = row.querySelector<HTMLElement>('[role="switch"]');
    expect(switchEl).not.toBeNull();
    expect(switchEl?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      switchEl?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(patchConfigMock).toHaveBeenCalledTimes(1);
    expect(patchConfigMock).toHaveBeenCalledWith({
      providers: { claude: { enabled: false } },
    });
  });
});
