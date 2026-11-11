import {
  workspaceBrowserAlternateDestinations,
  workspaceBrowserLinkDestinations,
  type BrowserLinkDestination,
} from "./opening";
import { useCallback, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent } from "@/components/ui/context-menu";
import { MenuItem } from "@/components/ui/menu";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { isWeb } from "@/constants/platform";
import { WorkspaceLinkPolicyProvider, useWorkspaceLinkOpening } from "./context";
import { LinkMenuContext, type LinkMenuWrapper } from "@/components/ui/link-menu-context";
import { openExternalUrl } from "@/utils/open-external-url";

/** Offer browser destinations while preserving the wrapped link's primary action. */
export function WorkspaceHttpLinkMenu({
  url,
  children,
  defaultDestination,
}: {
  url: string | null | undefined;
  children: ReactNode;
  defaultDestination?: BrowserLinkDestination;
}) {
  const policy = useWorkspaceLinkOpening();
  const openInPaseo = policy.openInPaseo;
  const primaryDestination = defaultDestination ?? policy.defaultDestination;
  const destinations = workspaceBrowserLinkDestinations({
    url,
    hasWorkspaceBrowser: Boolean(openInPaseo),
    defaultDestination: primaryDestination,
  });
  if (!isWeb || !url || destinations.length === 0) {
    return children;
  }
  return (
    <BrowserLinkMenu url={url} destinations={destinations}>
      {children}
    </BrowserLinkMenu>
  );
}

function BrowserLinkMenu({
  url,
  children,
  destinations,
}: {
  url: string;
  children: ReactNode;
  destinations: BrowserLinkDestination[];
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger contextOnly style={styles.inline}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent testID="workspace-http-link-menu">
        {destinations.map((destination) => (
          <BrowserDestinationMenuItem key={destination} url={url} destination={destination} />
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Browser destination rows for an existing dropdown whose own row already performs the primary
 * action. Renders nothing without a workspace browser (native, plain web, no workspace), and
 * otherwise only the destination the primary action does not use. Pass
 * `primaryFollowsWorkspaceLinks={false}` when that action obeys another setting, such as Service
 * URLs: where it goes is then unknown here, so both destinations are offered.
 */
export function WorkspaceBrowserDestinationItems({
  url,
  primaryFollowsWorkspaceLinks = true,
}: {
  url: string | null | undefined;
  primaryFollowsWorkspaceLinks?: boolean;
}) {
  const { openInPaseo, defaultDestination } = useWorkspaceLinkOpening();
  if (!isWeb || !url) {
    return null;
  }
  const resolveDestinations = primaryFollowsWorkspaceLinks
    ? workspaceBrowserAlternateDestinations
    : workspaceBrowserLinkDestinations;
  const destinations = resolveDestinations({
    url,
    hasWorkspaceBrowser: Boolean(openInPaseo),
    defaultDestination: primaryFollowsWorkspaceLinks ? defaultDestination : "external",
  });
  return destinations.map((destination) => (
    <BrowserDestinationMenuItem key={destination} url={url} destination={destination} />
  ));
}

function BrowserDestinationMenuItem({
  url,
  destination,
}: {
  url: string;
  destination: BrowserLinkDestination;
}) {
  const { t } = useTranslation();
  const { mutate, isPending } = useBrowserLinkOpening(url);
  const select = useCallback(() => mutate(destination), [mutate, destination]);
  const labelKey =
    destination === "paseo" ? "workspace.browser.openInPaseo" : "workspace.browser.openExternally";
  return (
    <MenuItem onSelect={select} disabled={isPending}>
      {t(labelKey)}
    </MenuItem>
  );
}

/**
 * Open `url` at an explicit destination. Pending and error ownership is the same whether the row
 * sits in a link's context menu or in an existing dropdown; failures become a toast.
 */
function useBrowserLinkOpening(url: string) {
  const toast = useToast();
  const { openInPaseo } = useWorkspaceLinkOpening();
  return useMutation({
    mutationFn: async (destination: BrowserLinkDestination) => {
      if (destination === "paseo") {
        if (!openInPaseo) {
          throw new Error("A workspace browser is unavailable.");
        }
        await openInPaseo(url);
      } else {
        await openExternalUrl(url);
      }
    },
    onError: (error: unknown) => toast.error(toErrorMessage(error)),
  });
}

/** Generic link components get workspace destinations; an always-external link keeps that default. */
const wrapInWorkspaceLinkMenu: LinkMenuWrapper = ({ url, primaryOpensExternally, children }) => (
  <WorkspaceHttpLinkMenu
    url={url}
    defaultDestination={primaryOpensExternally ? "external" : undefined}
  >
    {children}
  </WorkspaceHttpLinkMenu>
);

/**
 * Mounted once at the app root: the Workspace links policy, plus workspace destination menus
 * around links rendered by generic components (external links, Markdown links).
 */
export function WorkspaceLinksProvider({ children }: { children?: ReactNode }) {
  return (
    <WorkspaceLinkPolicyProvider>
      <LinkMenuContext.Provider value={wrapInWorkspaceLinkMenu}>
        {children}
      </LinkMenuContext.Provider>
    </WorkspaceLinkPolicyProvider>
  );
}

const styles = StyleSheet.create({ inline: { display: "contents" } });
