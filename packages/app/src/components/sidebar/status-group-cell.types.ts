import type { ReactNode } from "react";

/** Props shared by the platform implementations of a status-list workspace cell. */
export interface StatusGroupCellProps {
  workspaceKey: string;
  groupKey: string;
  /** The group a workspace belongs to in the latest projection, read when its cell unmounts. */
  resolveDestinationGroupKey: (workspaceKey: string) => string | undefined;
  children: ReactNode;
}
