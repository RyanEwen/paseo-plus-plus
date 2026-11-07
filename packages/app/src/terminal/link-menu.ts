import type { TFunction } from "i18next";
import type { TerminalLinkMenuAction, TerminalLinkMenuInput } from "@/desktop/host";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { isHttpUrl } from "@/utils/http-url";
import { openExternalUrl } from "@/utils/open-external-url";
import type { OpenWorkspaceBrowserUrl } from "@/workspace/browser/use-opening";

/**
 * The link section of the native terminal context menu for the hovered link, or undefined when
 * nothing is hovered or the target is not a web page (files, mail links).
 */
export function buildTerminalLinkMenuInput(input: {
  url: string | null | undefined;
  hasWorkspaceBrowser: boolean;
  t: TFunction;
}): TerminalLinkMenuInput | undefined {
  if (!input.url || !isHttpUrl(input.url)) {
    return undefined;
  }
  return {
    url: input.url,
    openInPaseo: input.hasWorkspaceBrowser,
    labels: {
      internal: input.t("workspace.browser.openInPaseo"),
      external: input.t("workspace.browser.openExternally"),
      copy: input.t("workspace.browser.copyLink"),
    },
  };
}

/**
 * Carry out the link action chosen in the native terminal menu. `null` means the menu closed
 * without a link choice (an editing role or a dismissal), which needs nothing here.
 */
export async function runTerminalLinkMenuAction(input: {
  action: TerminalLinkMenuAction | null;
  url: string;
  openInPaseo: OpenWorkspaceBrowserUrl | undefined;
}): Promise<void> {
  const { action, url, openInPaseo } = input;
  if (action === "open-internal") {
    // The menu offers this row only when the scope has a workspace browser.
    await openInPaseo?.(url);
    return;
  }
  if (action === "open-external") {
    await openExternalUrl(url);
    return;
  }
  if (action === "copy-link") {
    await copyToClipboard(url);
  }
}
