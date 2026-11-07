import { useCallback, useEffect, useMemo, useReducer, useRef, type Dispatch } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ToastApi } from "@/components/toast-host";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { selectHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspaceStructureProjects } from "@/stores/session-store-hooks/selectors";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import type { ProjectArchiveHost } from "./project-archive-discovery";
import {
  archiveConfirmedProjectWorkspace,
  runProjectArchive,
  type ProjectArchiveRunPorts,
  type ProjectArchiveRunResult,
} from "./project-archive-run";
import {
  buildProjectArchiveConfirmation,
  selectProjectArchiveScope,
  type ProjectArchiveConfirmation,
  type ProjectArchiveWorkspace,
} from "./project-workspace-archive";

/** Where one Archive all run is; the menu label and the background dialog derive from it. */
type ProjectArchiveStatus =
  | { phase: "idle" }
  | { phase: "discovering" }
  | { phase: "confirming" }
  | { phase: "choosing"; workspaces: ProjectArchiveWorkspace[]; hostCount: number }
  | { phase: "archiving"; completed: number; total: number };

type ProjectArchiveAction =
  | { type: "start" }
  | { type: "confirm" }
  | { type: "choose"; workspaces: ProjectArchiveWorkspace[]; hostCount: number }
  | { type: "progress"; completed: number; total: number }
  | { type: "finish" };

const IDLE: ProjectArchiveStatus = { phase: "idle" };

function reduceProjectArchiveStatus(
  _status: ProjectArchiveStatus,
  action: ProjectArchiveAction,
): ProjectArchiveStatus {
  switch (action.type) {
    case "start":
      return { phase: "discovering" };
    case "confirm":
      return { phase: "confirming" };
    case "choose":
      return { phase: "choosing", workspaces: action.workspaces, hostCount: action.hostCount };
    case "progress":
      return { phase: "archiving", completed: action.completed, total: action.total };
    case "finish":
      return IDLE;
  }
}

/** The pending menu label for a status; empty while idle. */
function projectArchivePendingLabel(status: ProjectArchiveStatus, t: TFunction): string {
  switch (status.phase) {
    case "idle":
      return "";
    case "discovering":
      return t("sidebar.project.archive.discovering");
    case "confirming":
    case "choosing":
      return t("sidebar.project.archive.title");
    case "archiving":
      return t("sidebar.project.archive.progress", {
        completed: status.completed,
        total: status.total,
      });
  }
}

/** The background opt-in waiting for the user; the owner renders the dialog for it. */
export interface ProjectArchiveBackgroundChoice {
  workspaces: ProjectArchiveWorkspace[];
  hostCount: number;
  choose: (confirmation: ProjectArchiveConfirmation) => void;
}

/** Archive all for one project row, shared by its dropdown and context menu surfaces. */
export interface ProjectArchiveController {
  archive: () => void;
  pending: boolean;
  pendingLabel: string;
  backgroundChoice: ProjectArchiveBackgroundChoice | null;
}

interface ProjectArchiveRunContext {
  projectName: string;
  hosts: readonly ProjectArchiveHost[];
  t: TFunction;
  toast: ToastApi;
  dispatch: Dispatch<ProjectArchiveAction>;
  mounted: { current: boolean };
  /** Resolves the open background dialog; set while one is showing. */
  pendingChoice: { current: ((confirmation: ProjectArchiveConfirmation) => void) | null };
}

/** Ask with the plain confirmation, or open the background opt-in when hidden work exists. */
async function confirmProjectArchive(
  context: ProjectArchiveRunContext,
  request: { workspaces: ProjectArchiveWorkspace[]; hostCount: number },
): Promise<ProjectArchiveConfirmation> {
  context.dispatch({ type: "confirm" });
  if (request.workspaces.some((workspace) => workspace.background)) {
    return new Promise<ProjectArchiveConfirmation>((resolve) => {
      context.pendingChoice.current = resolve;
      context.dispatch({ type: "choose", ...request });
    });
  }
  const confirmed = await confirmDialog(
    buildProjectArchiveConfirmation({
      projectName: context.projectName,
      hostCount: request.hostCount,
      selection: selectProjectArchiveScope(request.workspaces, false),
    }),
  );
  return confirmed ? { kind: "confirmed", includeBackground: false } : { kind: "cancelled" };
}

/** Wire the live session store, host runtime and dialogs into the Archive all ports. */
function createProjectArchivePorts(
  context: ProjectArchiveRunContext,
): ProjectArchiveRunPorts<DaemonClient> {
  const runtime = getHostRuntimeStore();
  return {
    requestedHosts: context.hosts,
    readProjects: () => {
      const state = useSessionStore.getState();
      return selectWorkspaceStructureProjects(state, Object.keys(state.sessions));
    },
    getClient: (serverId) =>
      runtime.getSnapshot(serverId)?.connectionStatus === "online"
        ? runtime.getClient(serverId)
        : null,
    // COMPAT(workspaceArchiveComplete): added in v0.12.0, remove after 2027-04-21.
    supportsArchive: (serverId) =>
      selectHostFeature(useSessionStore.getState(), serverId, "workspaceArchiveComplete"),
    isActive: () => context.mounted.current,
    confirm: (request) => confirmProjectArchive(context, request),
    archiveWorkspace: archiveConfirmedProjectWorkspace,
    onProgress: (completed, total) => {
      if (context.mounted.current) {
        context.dispatch({ type: "progress", completed, total });
      }
      context.toast.show(context.t("sidebar.project.archive.progress", { completed, total }), {
        durationMs: null,
      });
    },
  };
}

/** Tell the user how the run ended; cancelling or leaving says nothing. */
function reportProjectArchiveResult(
  result: ProjectArchiveRunResult,
  { t, toast }: Pick<ProjectArchiveRunContext, "t" | "toast">,
): void {
  switch (result.kind) {
    case "aborted":
    case "cancelled":
      return;
    case "empty":
      toast.show(t("sidebar.project.archive.empty"));
      return;
    case "error":
      toast.error(toErrorMessage(result.error));
      return;
    case "changed":
      toast.error(t("sidebar.project.archive.projectChanged"));
      return;
    case "archived":
      toast.show(t("sidebar.project.archive.completed", { count: result.archivedCount }), {
        variant: "success",
      });
      return;
    case "failed":
      toast.show(
        t("sidebar.project.archive.failed", {
          completed: result.archivedCount,
          workspace: result.failed.name,
          host: result.failed.serverId,
          unprocessed: result.unprocessedCount,
          error: toErrorMessage(result.error),
        }),
        { variant: "error", durationMs: null },
      );
  }
}

/** Run Archive all, report the result, and release the in-flight guard. */
async function runAndReportProjectArchive(
  context: ProjectArchiveRunContext,
  running: { current: boolean },
): Promise<void> {
  try {
    const result = await runProjectArchive(createProjectArchivePorts(context));
    reportProjectArchiveResult(result, context);
  } finally {
    running.current = false;
    if (context.mounted.current) {
      context.dispatch({ type: "finish" });
    }
  }
}

/** Own the project menu's Archive all operation once, shared by its dropdown and context surfaces. */
export function useProjectArchive(input: {
  projectName: string;
  hosts: readonly ProjectArchiveHost[];
}): ProjectArchiveController {
  const { t } = useTranslation();
  const toast = useToast();
  const [status, dispatch] = useReducer(reduceProjectArchiveStatus, IDLE);
  // A ref, not status: a second click can land before the first dispatch re-renders.
  const running = useRef(false);
  const mounted = useRef(true);
  const pendingChoice = useRef<((confirmation: ProjectArchiveConfirmation) => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingChoice.current?.({ kind: "cancelled" });
      pendingChoice.current = null;
    };
  }, []);

  const choose = useCallback((confirmation: ProjectArchiveConfirmation) => {
    const resolve = pendingChoice.current;
    pendingChoice.current = null;
    dispatch({ type: "confirm" });
    resolve?.(confirmation);
  }, []);

  const archive = useCallback(() => {
    if (running.current) return;
    running.current = true;
    dispatch({ type: "start" });
    void runAndReportProjectArchive(
      {
        projectName: input.projectName,
        hosts: input.hosts,
        t,
        toast,
        dispatch,
        mounted,
        pendingChoice,
      },
      running,
    );
  }, [input.hosts, input.projectName, t, toast]);

  const backgroundChoice = useMemo<ProjectArchiveBackgroundChoice | null>(
    () =>
      status.phase === "choosing"
        ? { workspaces: status.workspaces, hostCount: status.hostCount, choose }
        : null,
    [status, choose],
  );

  return {
    archive,
    pending: status.phase !== "idle",
    pendingLabel: projectArchivePendingLabel(status, t),
    backgroundChoice,
  };
}
