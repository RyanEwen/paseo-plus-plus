import { useQueryClient } from "@tanstack/react-query";
import { readPreviousAgentsAvailability } from "@/hooks/previous-agents-availability";
import {
  createPreviousAgentLaunchAction,
  isPreviousAgentsAvailable,
} from "@/hooks/previous-agents";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { SplitSide } from "@/components/split-layout-presets";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { ReopenClosedAgentDialog } from "@/components/reopen-closed-agent-dialog";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { Globe, History, SquarePen, SquareTerminal } from "lucide-react-native";
import invariant from "tiny-invariant";
import { useAppSettings } from "@/hooks/use-settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { pluginIconComponent } from "@/plugins/icons";
import { useInstalledPlugins } from "@/plugins/registry";
import { pluginPanelSupportsLocation } from "@/plugins/workspace-panels/locations";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { NewTabSelection } from "@/workspace-tabs/new-tab";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { panelCanLaunchInPane, panelSupportsHost, type PaneHost } from "@/panels/panel-manifest";
import {
  getPanelRegistration,
  type PanelIconProps,
  type PanelPresentation,
} from "@/panels/panel-registry";
import { ensurePanelsRegistered } from "@/panels/register-panels";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { getBuiltInLaunchOrder, type BuiltInLaunchItemId } from "./internal/catalog";

export type WorkspaceTabLaunchPurpose = "primary" | "supporting";

export type WorkspaceTabLaunchDestination =
  | { kind: "open"; paneId?: string }
  | { kind: "replace"; tabId: string }
  | { kind: "split"; paneId?: string; position: SplitSide; firstPaneFraction: number };

export interface NewTabLauncher {
  serverId: string;
  workspaceId: string;
  showChanges: boolean;
  showPullRequest: boolean;
  showBrowser: boolean;
  terminalDisabled: boolean;
  canSplit?: boolean;
  launch: (selection: NewTabSelection, destination: WorkspaceTabLaunchDestination) => void;
}

export interface WorkspaceTabLaunchItem {
  id: string;
  label: string;
  Icon?: ComponentType<PanelIconProps>;
  terminalIconKey?: string;
  shortcutActionId?: string;
  disabled: boolean;
  panelKind: WorkspaceTabTarget["kind"];
  launch: (destination: WorkspaceTabLaunchDestination) => void;
}

export interface WorkspaceTabLaunchGroup {
  id: "tabs" | "plugin-panels" | "terminal-profiles";
  label: string | null;
  items: readonly WorkspaceTabLaunchItem[];
  accessory?: { id: string; label: string; run: () => void };
}

const EMPTY_PANE_PANEL_KINDS: readonly WorkspaceTabTarget["kind"][] = [];

const NewTabLauncherContext = createContext<
  (NewTabLauncher & { previousAgentsEnabled: boolean; reopenClosedAgent: () => void }) | null
>(null);

/** Own launcher actions and their workspace-scoped reopen dialog together. */
export function NewTabLauncherProvider({
  value,
  children,
}: {
  value: NewTabLauncher;
  children: ReactNode;
}) {
  const { settings, isReadReady } = useAppSettings();
  const queryClient = useQueryClient();
  const availability = {
    serverId: value.serverId,
    workspaceId: value.workspaceId,
    readReady: isReadReady,
    enabled: settings.paseoPlusPlus.previousAgents,
  };
  const previousAgentsEnabled = isPreviousAgentsAvailable(availability);
  const [reopenIdentity, setReopenIdentity] = useState<{
    serverId: string;
    workspaceId: string;
  } | null>(null);
  const readAvailability = useStableEvent(() =>
    readPreviousAgentsAvailability({
      queryClient,
      identity: { serverId: value.serverId, workspaceId: value.workspaceId },
    }),
  );
  const reopenClosedAgent = useMemo(
    () =>
      createPreviousAgentLaunchAction({
        identity: { serverId: value.serverId, workspaceId: value.workspaceId },
        readAvailability,
        open: setReopenIdentity,
      }),
    [readAvailability, value.serverId, value.workspaceId],
  );
  const closeReopenDialog = useCallback(() => setReopenIdentity(null), []);
  const sameWorkspace =
    reopenIdentity?.serverId === value.serverId &&
    reopenIdentity?.workspaceId === value.workspaceId;
  // Hide synchronously; clear the invocation so re-enabling never remounts an old dialog.
  useEffect(() => {
    if (!previousAgentsEnabled || !sameWorkspace) setReopenIdentity(null);
  }, [previousAgentsEnabled, sameWorkspace]);
  const context = useMemo(
    () => ({ ...value, previousAgentsEnabled, reopenClosedAgent }),
    [value, previousAgentsEnabled, reopenClosedAgent],
  );
  return (
    <NewTabLauncherContext.Provider value={context}>
      {children}
      {previousAgentsEnabled && sameWorkspace && reopenIdentity ? (
        <ReopenClosedAgentDialog
          serverId={reopenIdentity.serverId}
          workspaceId={reopenIdentity.workspaceId}
          onClose={closeReopenDialog}
        />
      ) : null}
    </NewTabLauncherContext.Provider>
  );
}

/** Creation menus only expose split actions where the owning workspace can display panes. */
export function useWorkspaceTabSplitLaunchEnabled(): boolean {
  return useContext(NewTabLauncherContext)?.canSplit === true;
}

const BUILT_IN_SELECTIONS = {
  agent: { kind: "agent" },
  terminal: { kind: "terminal" },
  changes: { kind: "target", target: { kind: "changes_tree" } },
  diff: { kind: "target", target: { kind: "working_diff" } },
  files: { kind: "target", target: { kind: "files" } },
  browser: { kind: "browser" },
  pullRequest: { kind: "target", target: { kind: "pull_request" } },
} satisfies Record<BuiltInLaunchItemId, NewTabSelection>;

function getLaunchPresentation(kind: WorkspaceTabTarget["kind"]): PanelPresentation {
  const registration = getPanelRegistration(kind);
  invariant(registration?.presentation, `Panel ${kind} has no launch presentation`);
  return registration.presentation;
}

export function useWorkspaceTabLaunchCatalog(input: {
  serverId: string;
  purpose: WorkspaceTabLaunchPurpose;
  host: PaneHost;
  surface: "menu" | "panel";
  panePanelKinds?: readonly WorkspaceTabTarget["kind"][];
}): readonly WorkspaceTabLaunchGroup[] {
  const { serverId, purpose, host, surface, panePanelKinds = EMPTY_PANE_PANEL_KINDS } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const launcher = useContext(NewTabLauncherContext);
  invariant(launcher, "NewTabLauncherProvider is required");
  const { config } = useDaemonConfig(serverId);
  const plugins = useInstalledPlugins();
  const isCompact = useIsCompactFormFactor();
  ensurePanelsRegistered();

  const launchSelection = useCallback(
    (selection: NewTabSelection) => (destination: WorkspaceTabLaunchDestination) => {
      launcher.launch(selection, destination);
    },
    [launcher],
  );
  const editTerminalProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "terminals") as Href);
  }, [router, serverId]);

  return useMemo(() => {
    const isExplorerMenu = host === "explorer" && surface === "menu";
    const changesPresentation = getLaunchPresentation("changes_tree");
    const diffPresentation = getLaunchPresentation("working_diff");
    const filesPresentation = getLaunchPresentation("files");
    const pullRequestPresentation = getLaunchPresentation("pull_request");
    const builtIns: Record<BuiltInLaunchItemId, WorkspaceTabLaunchItem & { hidden?: boolean }> = {
      agent: {
        id: "agent",
        label: t("workspace.tabs.fallback.agent"),
        Icon: SquarePen,
        shortcutActionId: "workspace-tab-target-agent",
        disabled: false,
        panelKind: "draft",
        launch: launchSelection(BUILT_IN_SELECTIONS.agent),
      },
      terminal: {
        id: "terminal",
        label: t("workspace.tabs.fallback.terminal"),
        Icon: SquareTerminal,
        shortcutActionId: "workspace-terminal-new",
        disabled: launcher.terminalDisabled,
        panelKind: "terminal",
        launch: launchSelection(BUILT_IN_SELECTIONS.terminal),
      },
      changes: {
        id: "changes",
        label: changesPresentation.label(t),
        Icon: changesPresentation.icon,
        disabled: false,
        panelKind: "changes_tree",
        hidden: !launcher.showChanges,
        launch: launchSelection(BUILT_IN_SELECTIONS.changes),
      },
      diff: {
        id: "diff",
        label: diffPresentation.label(t),
        Icon: diffPresentation.icon,
        shortcutActionId: "workspace-tab-target-changes",
        disabled: false,
        panelKind: "working_diff",
        // Compact Changes shows each file's diff inline, so a separate Diff panel is redundant.
        hidden: !launcher.showChanges || isCompact,
        launch: launchSelection(BUILT_IN_SELECTIONS.diff),
      },
      files: {
        id: "files",
        label: filesPresentation.label(t),
        Icon: filesPresentation.icon,
        shortcutActionId: "workspace-tab-target-files",
        disabled: false,
        panelKind: "files",
        launch: launchSelection(BUILT_IN_SELECTIONS.files),
      },
      browser: {
        id: "browser",
        label: t("workspace.tabs.fallback.browser"),
        Icon: Globe,
        shortcutActionId: "workspace-tab-target-browser",
        disabled: false,
        panelKind: "browser",
        hidden: !launcher.showBrowser,
        launch: launchSelection(BUILT_IN_SELECTIONS.browser),
      },
      pullRequest: {
        id: "pull-request",
        label: pullRequestPresentation.label(t),
        Icon: pullRequestPresentation.icon,
        disabled: false,
        panelKind: "pull_request",
        hidden: !launcher.showPullRequest,
        launch: launchSelection(BUILT_IN_SELECTIONS.pullRequest),
      },
    };
    const tabItems = getBuiltInLaunchOrder(purpose).flatMap((id) => {
      const item = builtIns[id];
      return item.hidden || !panelSupportsHost(item.panelKind, host) ? [] : [item];
    });

    if (!isExplorerMenu && launcher.previousAgentsEnabled) {
      tabItems.splice(1, 0, {
        id: "reopen-closed-agent",
        label: t("sessions.previousTitle"),
        Icon: History,
        disabled: false,
        panelKind: "agent",
        launch: launcher.reopenClosedAgent,
      });
    }

    const pluginItems: WorkspaceTabLaunchItem[] = [];
    for (const plugin of plugins) {
      if (plugin.serverId !== serverId) continue;
      for (const panel of plugin.workspacePanels) {
        if (panel.context !== "workspace") continue;
        const location = host === "explorer" ? "explorer" : "workspace";
        if (!pluginPanelSupportsLocation(panel, location)) continue;
        const selection: NewTabSelection = {
          kind: "target",
          target: { kind: "plugin", pluginId: plugin.id, panelId: panel.id, context: "workspace" },
        };
        pluginItems.push({
          id: `plugin:${plugin.id}:${panel.id}`,
          label: plugin.i18n.resolve(panel.title, plugin.locale),
          Icon: pluginIconComponent(panel.icon),
          disabled: false,
          panelKind: "plugin",
          launch: launchSelection(selection),
        });
      }
    }

    const profiles = resolveTerminalProfiles(config?.terminalProfiles);
    const groups: WorkspaceTabLaunchGroup[] = [{ id: "tabs", label: null, items: tabItems }];
    if (pluginItems.length > 0) {
      groups.push({ id: "plugin-panels", label: null, items: pluginItems });
    }
    if (profiles.length > 0) {
      groups.push({
        id: "terminal-profiles",
        label: t("workspace.tabs.actions.terminalProfilesMenu"),
        items: profiles.map((profile: TerminalProfile) => ({
          id: `terminal-profile:${profile.id}`,
          label: profile.name,
          terminalIconKey: getTerminalProfileIcon(profile),
          disabled: launcher.terminalDisabled,
          panelKind: "terminal",
          launch: launchSelection({ kind: "terminal", profile }),
        })),
        accessory: {
          id: "edit-terminal-profiles",
          label: t("workspace.tabs.actions.editTerminalProfiles"),
          run: editTerminalProfiles,
        },
      });
    }
    if (surface !== "menu") return groups;
    return groups.flatMap((group) => {
      const items = group.items.filter((item) =>
        panelCanLaunchInPane(item.panelKind, panePanelKinds),
      );
      return items.length > 0 ? [{ ...group, items }] : [];
    });
  }, [
    config?.terminalProfiles,
    editTerminalProfiles,
    isCompact,
    launchSelection,
    launcher,
    plugins,
    purpose,
    host,
    surface,
    panePanelKinds,
    serverId,
    t,
  ]);
}

export { getBuiltInLaunchOrder } from "./internal/catalog";
