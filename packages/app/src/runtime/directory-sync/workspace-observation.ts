import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { DirectorySourceToken } from "./transaction";

/** A complete current-source baseline followed by accepted upserts; cache paint is not fresh authority. */
export interface WorkspaceDirectoryObserver {
  snapshot(workspaces: readonly WorkspaceDescriptor[]): void;
  update(workspaces: readonly WorkspaceDescriptor[]): void;
  error(error: unknown): void;
}

/**
 * Workspace-only observers (notification receipts) and the source state that decides when they
 * may hear about workspaces. They share the directory producer with UI demand without demanding
 * agents or projects themselves.
 */
export class WorkspaceObservation {
  private readonly observers = new Set<WorkspaceDirectoryObserver>();
  /** The source whose complete workspace baseline is current, or null before one is accepted. */
  workspaceSnapshotSource: DirectorySourceToken | null = null;
  /** The source whose project list is current, or null when projects must be fetched again. */
  projectSnapshotSource: DirectorySourceToken | null = null;
  /** Set once any network workspace baseline was accepted; cache reads must not override it. */
  baselineAccepted = false;

  get hasObservers(): boolean {
    return this.observers.size > 0;
  }

  add(observer: WorkspaceDirectoryObserver): void {
    this.observers.add(observer);
  }

  delete(observer: WorkspaceDirectoryObserver): void {
    this.observers.delete(observer);
  }

  clear(): void {
    this.observers.clear();
  }

  /** Forget the workspace baseline source when its subscription is released. */
  releaseWorkspaceSource(): void {
    this.workspaceSnapshotSource = null;
  }

  /** Report a failed observation to every observer. */
  fail(error: unknown): void {
    for (const observer of this.observers) observer.error(error);
  }

  /** Hand every observer the complete current workspace baseline. */
  publishSnapshot(workspaces: readonly WorkspaceDescriptor[]): void {
    this.notify((observer) => observer.snapshot(workspaces));
  }

  /** Hand every observer the accepted workspace upserts, when there are any. */
  publishUpserts(workspaces: readonly WorkspaceDescriptor[]): void {
    if (workspaces.length === 0) return;
    this.notify((observer) => observer.update(workspaces));
  }

  /** Call each observer; a throwing observer hears its own failure without stopping the others. */
  private notify(deliver: (observer: WorkspaceDirectoryObserver) => void): void {
    for (const observer of this.observers) {
      try {
        deliver(observer);
      } catch (error) {
        observer.error(error);
      }
    }
  }
}
