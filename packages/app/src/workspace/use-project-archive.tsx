import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspaceStructureProjects } from "@/stores/session-store-hooks/selectors";
import { getLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { redirectIfArchivingActiveWorkspace } from "@/utils/sidebar-workspace-archive-redirect";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { archiveWorkspaceOptimistically } from "./workspace-archive";
import { purgeArchivedWorkspaceState } from "./workspace-archive-layout";
import {
  discoverProjectArchiveWorkspaces,
  resolveProjectArchiveHosts,
  type ProjectArchiveHost,
} from "./project-archive-discovery";
import {
  archiveProjectWorkspaces,
  buildProjectArchiveConfirmation,
  selectProjectArchiveScope,
  type ProjectArchiveWorkspace,
} from "./project-workspace-archive";
import { ProjectArchiveBackgroundDialog } from "./project-archive-background-dialog";
import { verifyProjectWorkspaceArchive } from "./project-archive-verification";

interface BackgroundConfirmation {
  workspaces: ProjectArchiveWorkspace[];
  hostCount: number;
}

/** Own the project menu operation once, shared by its dropdown and context surfaces. */
export function useProjectArchive(input: {
  projectName: string;
  hosts: readonly ProjectArchiveHost[];
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [pendingLabel, setPendingLabel] = useState("");
  const [confirmation, setConfirmation] = useState<BackgroundConfirmation | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const confirmationResolver = useRef<((includeBackground: boolean | null) => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      confirmationResolver.current?.(null);
      confirmationResolver.current = null;
    };
  }, []);

  const chooseBackground = useCallback((includeBackground: boolean | null) => {
    const resolve = confirmationResolver.current;
    confirmationResolver.current = null;
    setConfirmation(null);
    resolve?.(includeBackground);
  }, []);

  const archive = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setPendingLabel(t("sidebar.project.archive.discovering"));

    /** Keep failures inside the menu action, including discovery and confirmation backends. */
    async function run() {
      try {
        const state = useSessionStore.getState();
        const projects = selectWorkspaceStructureProjects(state, Object.keys(state.sessions));
        const hosts = resolveProjectArchiveHosts({ hosts: input.hosts, projects });
        if (hosts.length === 0) throw new Error(t("sidebar.project.archive.projectChanged"));
        const runtime = getHostRuntimeStore();
        const getClient = (serverId: string) =>
          runtime.getSnapshot(serverId)?.connectionStatus === "online"
            ? runtime.getClient(serverId)
            : null;
        const discover = () =>
          discoverProjectArchiveWorkspaces({
            hosts,
            getClient,
            // COMPAT(workspaceArchiveComplete): added in v0.12.0, remove after 2027-04-21.
            supportsArchive: (serverId) =>
              useSessionStore.getState().sessions[serverId]?.serverInfo?.features
                ?.workspaceArchiveComplete === true,
          });
        const workspaces = await discover();
        if (!mounted.current) return;
        if (workspaces.length === 0) {
          toast.show(t("sidebar.project.archive.empty"));
          return;
        }

        const outcome = await archiveProjectWorkspaces({
          workspaces,
          confirm: async (entries) => {
            if (!mounted.current) return null;
            setPendingLabel(t("sidebar.project.archive.title"));
            if (entries.some((workspace) => workspace.background)) {
              return new Promise<boolean | null>((resolve) => {
                confirmationResolver.current = resolve;
                setConfirmation({ workspaces: entries, hostCount: hosts.length });
              });
            }
            const confirmed = await confirmDialog(
              buildProjectArchiveConfirmation({
                projectName: input.projectName,
                hostCount: hosts.length,
                selection: selectProjectArchiveScope(entries, false),
              }),
            );
            return confirmed ? false : null;
          },
          refresh: async () => {
            const current = useSessionStore.getState();
            const currentProjects = selectWorkspaceStructureProjects(
              current,
              Object.keys(current.sessions),
            );
            const currentHosts = resolveProjectArchiveHosts({
              hosts: input.hosts,
              projects: currentProjects,
            });
            const hostKey = (host: ProjectArchiveHost) =>
              JSON.stringify([host.serverId, host.projectId]);
            const expectedHosts = hosts.map(hostKey).sort();
            const observedHosts = currentHosts.map(hostKey).sort();
            if (JSON.stringify(expectedHosts) !== JSON.stringify(observedHosts)) {
              throw new Error(t("sidebar.project.archive.projectChanged"));
            }
            return discover();
          },
          archive: async (workspace) => {
            const client = getClient(workspace.serverId);
            if (!client)
              throw new Error(
                t("sidebar.project.archive.hostDisconnected", { host: workspace.serverId }),
              );
            await archiveWorkspaceOptimistically({ client, workspace });
            await verifyProjectWorkspaceArchive({ client, workspace });
            purgeArchivedWorkspaceState(workspace);
            redirectIfArchivingActiveWorkspace({
              ...workspace,
              activeWorkspaceSelection: getLastWorkspaceSelection(),
            });
          },
          onProgress: (completed, total) => {
            const label = t("sidebar.project.archive.progress", { completed, total });
            if (mounted.current) setPendingLabel(label);
            toast.show(label, { durationMs: null });
          },
        });

        if (outcome.kind === "failed") {
          toast.show(
            t("sidebar.project.archive.failed", {
              completed: outcome.archivedCount,
              workspace: outcome.failed.name,
              host: outcome.failed.serverId,
              unprocessed: outcome.unprocessedCount,
              error: toErrorMessage(outcome.error),
            }),
            { variant: "error", durationMs: null },
          );
        } else if (outcome.kind === "changed") {
          toast.error(t("sidebar.project.archive.projectChanged"));
        } else if (outcome.kind === "archived") {
          toast.show(t("sidebar.project.archive.completed", { count: outcome.archivedCount }), {
            variant: "success",
          });
        }
      } catch (error) {
        toast.error(toErrorMessage(error));
      } finally {
        busy.current = false;
        if (mounted.current) setPending(false);
      }
    }
    void run();
  }, [input.hosts, input.projectName, t, toast]);

  return {
    archive,
    pending,
    pendingLabel,
    confirmation: confirmation ? (
      <ProjectArchiveBackgroundDialog
        projectName={input.projectName}
        hostCount={confirmation.hostCount}
        workspaces={confirmation.workspaces}
        onChoose={chooseBackground}
      />
    ) : null,
  };
}
