import { useWorkspaceLinkOpening } from "@/workspace/browser/context";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react";
import React from "react";
import type { ToastApi } from "@/components/toast-host";
import type { OpenFileDisposition } from "@/workspace/file-open";
import type { InlinePathTarget } from "./parse";
import type { AssistantFileLinkContext, GetDirectorySuggestions } from "./resolver";

export interface AssistantFileLinkDaemonClient {
  readFile?: import("@getpaseo/client/internal/daemon-client").DaemonClient["readFile"];
  getDirectorySuggestions: GetDirectorySuggestions;
}

export interface AssistantFileLinkResolverConfig {
  client?: AssistantFileLinkDaemonClient | null;
  serverId?: string;
  workspaceRoot?: string;
  relativePathBase?: string;
  onOpenWorkspaceFile?: (target: InlinePathTarget, disposition: OpenFileDisposition) => void;
  toast?: ToastApi | null;
}

/** Provider config plus the HTTP opener of the workspace link scope the provider sits in. */
export interface AssistantFileLinkResolverState extends AssistantFileLinkResolverConfig {
  /** Primary HTTP(S) activation; reads the Workspace links preference when called. */
  openHttpLink: (url: string) => Promise<void>;
}

export interface AssistantFileLinkResolverProviderProps extends AssistantFileLinkResolverConfig {
  children: ReactNode;
}

export interface AssistantFileLinkResolverContextValue {
  configRef: MutableRefObject<AssistantFileLinkResolverState>;
  getDirectorySuggestions: GetDirectorySuggestions;
}

const AssistantFileLinkResolverContext =
  createContext<AssistantFileLinkResolverContextValue | null>(null);

export function useAssistantFileLinkEnvironmentBridge() {
  const value = useContext(AssistantFileLinkResolverContext);
  return useCallback(
    (children: ReactNode) => (
      <AssistantFileLinkResolverContext.Provider value={value}>
        {children}
      </AssistantFileLinkResolverContext.Provider>
    ),
    [value],
  );
}

export function AssistantFileLinkResolverProvider({
  client,
  serverId,
  workspaceRoot,
  relativePathBase,
  onOpenWorkspaceFile,
  toast,
  children,
}: AssistantFileLinkResolverProviderProps) {
  const { openPrimary } = useWorkspaceLinkOpening();

  const configRef = useRef<AssistantFileLinkResolverState>({
    client,
    serverId,
    workspaceRoot,
    relativePathBase,
    onOpenWorkspaceFile,
    toast,
    openHttpLink: openPrimary,
  });
  configRef.current = {
    client,
    serverId,
    workspaceRoot,
    relativePathBase,
    onOpenWorkspaceFile,
    toast,
    openHttpLink: openPrimary,
  };

  const getDirectorySuggestions = useCallback<GetDirectorySuggestions>(async (input) => {
    const activeClient = configRef.current.client;
    if (!activeClient) {
      return { entries: [], error: null };
    }

    const result = await activeClient.getDirectorySuggestions(input);
    return { entries: result.entries, error: result.error };
  }, []);

  const value = useMemo<AssistantFileLinkResolverContextValue>(
    () => ({ configRef, getDirectorySuggestions }),
    [getDirectorySuggestions],
  );

  return (
    <AssistantFileLinkResolverContext.Provider value={value}>
      {children}
    </AssistantFileLinkResolverContext.Provider>
  );
}

export function useAssistantFileLinkResolverContext(): AssistantFileLinkResolverContextValue {
  const context = useContext(AssistantFileLinkResolverContext);
  return context ?? EMPTY_CONTEXT;
}

export type { AssistantFileLinkContext };

/** Without a resolver there is no workspace scope or toast: open externally and log failures. */
async function openHttpLinkOutsideResolver(url: string): Promise<void> {
  await openExternalUrl(url).catch((error: unknown) => console.error(error));
}

const EMPTY_CONTEXT: AssistantFileLinkResolverContextValue = {
  configRef: { current: { openHttpLink: openHttpLinkOutsideResolver } },
  getDirectorySuggestions: async () => ({ entries: [], error: null }),
};

export function useAssistantFileLinkEnvironment() {
  return useAssistantFileLinkResolverContext().configRef.current;
}
