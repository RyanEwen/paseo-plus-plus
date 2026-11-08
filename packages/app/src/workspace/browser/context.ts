import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
// Not toast-context: that module loads the toast UI, which this widely imported module must not.
import { useToast } from "@/contexts/toast-api-context";
import { useAppSettings } from "@/hooks/use-settings";
import { toErrorMessage } from "@/utils/error-messages";
import { openExternalUrl } from "@/utils/open-external-url";
import { openWorkspaceLink, type BrowserLinkDestination } from "./opening";
import type { OpenWorkspaceBrowserUrl } from "./use-opening";

/**
 * The app-wide half of workspace link opening: the **Workspace links** preference and the error
 * reporter. `isEnabled` is read when a link is activated, so a callback captured before the
 * preference changed still follows the latest choice; `enabled` is the reactive copy that menus
 * use to label the primary destination.
 */
export interface WorkspaceLinkPolicy {
  enabled: boolean;
  isEnabled: () => boolean;
  reportError: (error: unknown) => void;
}

/** Outside the app root (and in tests that do not opt in), primary clicks open externally. */
const DISABLED_POLICY: WorkspaceLinkPolicy = {
  enabled: false,
  isEnabled: () => false,
  reportError: (error) => console.error(error),
};

/** Port for the link policy. Production mounts {@link WorkspaceLinkPolicyProvider}; tests provide a value. */
export const WorkspaceLinkPolicyContext = createContext(DISABLED_POLICY);

const WorkspaceBrowserOpenerContext = createContext<OpenWorkspaceBrowserUrl | undefined>(undefined);

/** Read the preference and the toast once for the whole app, not once per link scope. */
export function WorkspaceLinkPolicyProvider({ children }: { children?: ReactNode }) {
  const { settings } = useAppSettings();
  const enabled = settings.paseoPlusPlus.workspaceChatLinks;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const isEnabled = useCallback(() => enabledRef.current, []);

  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const reportError = useCallback((error: unknown) => {
    toastRef.current.error(toErrorMessage(error));
  }, []);

  const policy = useMemo<WorkspaceLinkPolicy>(
    () => ({ enabled, isEnabled, reportError }),
    [enabled, isEnabled, reportError],
  );
  return createElement(WorkspaceLinkPolicyContext.Provider, { value: policy }, children);
}

/**
 * Give descendants the built-in browser opener of the workspace that owns their links.
 * `value` is undefined where there is no built-in browser (native, plain web, no workspace).
 */
export function WorkspaceBrowserOpenerProvider({
  value,
  children,
}: {
  value: OpenWorkspaceBrowserUrl | undefined;
  children?: ReactNode;
}) {
  return createElement(WorkspaceBrowserOpenerContext.Provider, { value }, children);
}

export interface WorkspaceLinkOpening {
  /** Explicit "open in Paseo browser" destination; ignores the preference. */
  openInPaseo: OpenWorkspaceBrowserUrl | undefined;
  /** Primary activation: follows the preference at call time and reports failures itself. */
  openPrimary: (url: string) => Promise<void>;
  reportError: (error: unknown) => void;
  /** Where a primary click goes right now, for menus that offer the other destination. */
  defaultDestination: BrowserLinkDestination;
}

/**
 * The opener as a fire-and-forget callback for callers that ignore its result, such as the upstream
 * Service URLs path. Failures are reported like any other link failure; without an opener it does nothing.
 */
export function useReportedBrowserOpener(
  openInPaseo: OpenWorkspaceBrowserUrl | undefined,
): (url: string) => void {
  const { reportError } = useContext(WorkspaceLinkPolicyContext);
  return useCallback(
    (url: string) => {
      const open = async () => {
        await openInPaseo?.(url);
      };
      open().catch(reportError);
    },
    [openInPaseo, reportError],
  );
}

/** Primary activation always belongs to the nearest opener scope, never the globally selected workspace. */
export function useWorkspaceLinkOpening(): WorkspaceLinkOpening {
  const { enabled, isEnabled, reportError } = useContext(WorkspaceLinkPolicyContext);
  const openInPaseo = useContext(WorkspaceBrowserOpenerContext);
  const openPrimary = useCallback(
    (url: string) =>
      openWorkspaceLink(url, { isEnabled, openInPaseo, openExternally: openExternalUrl }).catch(
        reportError,
      ),
    [isEnabled, openInPaseo, reportError],
  );
  return useMemo(
    () => ({
      openInPaseo,
      openPrimary,
      reportError,
      defaultDestination: enabled && openInPaseo ? "paseo" : "external",
    }),
    [openInPaseo, openPrimary, reportError, enabled],
  );
}
