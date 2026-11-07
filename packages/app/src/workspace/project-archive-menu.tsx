import { useCallback, useMemo, useState, type ComponentProps, type PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ArchiveRestore } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { RestoreProjectWorkspaceDialog } from "@/components/restore-project-workspace-dialog";
import type { Theme } from "@/styles/theme";
import type { ProjectArchiveHost } from "./project-archive-discovery";
import { ProjectArchiveBackgroundDialog } from "./project-archive-background-dialog";
import {
  resolveProjectRestoreHosts,
  type ProjectArchiveRestoreHost,
} from "./project-archive-restore";
import { useProjectArchive, type ProjectArchiveController } from "./use-project-archive";

const ThemedArchive = withUnistyles(Archive);
const ThemedArchiveRestore = withUnistyles(ArchiveRestore);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;
const restoreLeadingIcon = (
  <ThemedArchiveRestore size={14} uniProps={foregroundMutedColorMapping} />
);

/** The project menu surfaces that host the archive entries. */
export type ProjectArchiveMenuSurface = "context" | "dropdown";

/**
 * Archive all and Restore archived workspace for one project row, shared by its dropdown and
 * context menu surfaces and by the dialogs the row mounts.
 */
export interface ProjectArchiveMenuController {
  projectName: string;
  archive: ProjectArchiveController;
  /** Hosts whose archives the restore chooser lists; empty hides the entry. */
  restoreHosts: ProjectArchiveRestoreHost[];
  restoreOpen: boolean;
  openRestore: () => void;
  closeRestore: () => void;
}

/** Own the archive pair for a sidebar project row. */
export function useProjectArchiveMenu(input: {
  projectName: string;
  hosts: readonly ProjectArchiveHost[];
}): ProjectArchiveMenuController {
  const archive = useProjectArchive(input);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const openRestore = useCallback(() => setRestoreOpen(true), []);
  const closeRestore = useCallback(() => setRestoreOpen(false), []);
  const restoreHosts = useMemo(
    () => resolveProjectRestoreHosts({ hosts: input.hosts }),
    [input.hosts],
  );
  return useMemo(
    () => ({
      projectName: input.projectName,
      archive,
      restoreHosts,
      restoreOpen,
      openRestore,
      closeRestore,
    }),
    [input.projectName, archive, restoreHosts, restoreOpen, openRestore, closeRestore],
  );
}

/** The same menu row on either surface. */
function ArchiveMenuItem({
  surface,
  children,
  ...props
}: PropsWithChildren<
  Omit<ComponentProps<typeof DropdownMenuItem>, "children"> & {
    surface: ProjectArchiveMenuSurface;
  }
>) {
  if (surface === "context") {
    return <ContextMenuItem {...props}>{children}</ContextMenuItem>;
  }
  return <DropdownMenuItem {...props}>{children}</DropdownMenuItem>;
}

/** Opens the project's archive chooser; absent while the project has no host. */
export function RestoreArchivedWorkspaceMenuItem({
  surface,
  projectViewKey,
  menu,
}: {
  surface: ProjectArchiveMenuSurface;
  projectViewKey: string;
  menu: ProjectArchiveMenuController;
}) {
  const { t } = useTranslation();
  if (menu.restoreHosts.length === 0) {
    return null;
  }
  return (
    <ArchiveMenuItem
      surface={surface}
      testID={`sidebar-project-menu-restore-${projectViewKey}`}
      leading={restoreLeadingIcon}
      onSelect={menu.openRestore}
    >
      {t("sidebar.project.restore.title")}
    </ArchiveMenuItem>
  );
}

/** Runs Archive all; disabled while the project is being removed. */
export function ArchiveAllMenuItem({
  surface,
  projectViewKey,
  menu,
  removePending,
}: {
  surface: ProjectArchiveMenuSurface;
  projectViewKey: string;
  menu: ProjectArchiveMenuController;
  removePending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <ArchiveMenuItem
      surface={surface}
      testID={`sidebar-project-menu-archive-all-${projectViewKey}`}
      leading={archiveLeadingIcon}
      status={menu.archive.pending ? "pending" : "idle"}
      pendingLabel={menu.archive.pendingLabel}
      disabled={removePending}
      onSelect={menu.archive.archive}
    >
      {t("sidebar.project.archive.action")}
    </ArchiveMenuItem>
  );
}

/** The restore chooser and the Archive all background opt-in, mounted once per project row. */
export function ProjectArchiveMenuDialogs({
  menu,
  onWorkspacePress,
}: {
  menu: ProjectArchiveMenuController;
  onWorkspacePress?: () => void;
}) {
  const choice = menu.archive.backgroundChoice;
  return (
    <>
      <RestoreProjectWorkspaceDialog
        visible={menu.restoreOpen}
        hosts={menu.restoreHosts}
        onClose={menu.closeRestore}
        onWorkspacePress={onWorkspacePress}
      />
      {choice ? (
        <ProjectArchiveBackgroundDialog
          projectName={menu.projectName}
          hostCount={choice.hostCount}
          workspaces={choice.workspaces}
          onChoose={choice.choose}
        />
      ) : null}
    </>
  );
}
