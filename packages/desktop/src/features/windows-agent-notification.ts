import type { NotificationCloseEventParams } from "electron";
import { NotificationReceiptDataSchema } from "@getpaseo/protocol/notification-receipts";
import { buildAgentDeepLink, parseAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";

interface WindowsAgentNotificationInput {
  notificationId: string;
  title: string;
  body: string | undefined;
  data: Record<string, unknown> | undefined;
  iconPath: string | null;
  silent: boolean;
}

/** XML 1.0 allows whitespace controls and valid Unicode, but rejects lone surrogates. */
function isXmlCharacter(character: string): boolean {
  if (character.length === 2) {
    return true;
  }
  const code = character.charCodeAt(0);
  const isWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
  const isBeforeSurrogates = code >= 0x20 && code <= 0xd7ff;
  const isAfterSurrogates = code >= 0xe000 && code <= 0xfffd;
  return isWhitespace || isBeforeSurrogates || isAfterSurrogates;
}

function escapeXml(value: string): string {
  // Provider text can contain terminal control characters, which XML rejects.
  const xmlText = Array.from(value).filter(isXmlCharacter).join("");
  return xmlText
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Return durable activation arguments only when the notification names a valid chat target. */
export function buildWindowsAgentNotificationArguments(
  input: Pick<WindowsAgentNotificationInput, "data" | "notificationId">,
): string | null {
  const serverId = input.data?.serverId;
  const agentId = input.data?.agentId;
  if (typeof serverId !== "string" || typeof agentId !== "string") {
    return null;
  }
  if (!serverId.trim() || !agentId.trim()) {
    return null;
  }

  // The tag correlates instance clicks with durable activations.
  const parameters = new URLSearchParams({
    type: "click",
    tag: input.notificationId,
    paseoAgent: buildAgentDeepLink({ serverId, agentId }),
  });
  const receipt = NotificationReceiptDataSchema.safeParse(input.data);
  if (receipt.success) parameters.set("paseoReceipt", JSON.stringify(receipt.data));
  return parameters.toString();
}

/** Embed the stable chat URL in the toast so activation survives renderer reloads and app restarts. */
export function buildWindowsAgentToast(input: WindowsAgentNotificationInput): string | null {
  const launchArguments = buildWindowsAgentNotificationArguments(input);
  if (!launchArguments) {
    return null;
  }
  const launch = escapeXml(launchArguments);
  const body = input.body ? `<text>${escapeXml(input.body)}</text>` : "";
  const icon = input.iconPath
    ? `<image placement="appLogoOverride" hint-crop="none" src="${escapeXml(input.iconPath)}"/>`
    : "";
  const audio = input.silent ? '<audio silent="true"/>' : "";
  return `<toast launch="${launch}" activationType="foreground"><visual><binding template="ToastGeneric"><text>${escapeXml(input.title)}</text>${body}${icon}</binding></visual>${audio}</toast>`;
}

/** Only accept Paseo chat activations, leaving other Windows notification actions alone. */
export function openWindowsAgentNotification(
  input: { type: string; arguments: string },
  openAgentLink: (url: string) => void,
): void {
  if (input.type !== "click") {
    return;
  }
  const link = new URLSearchParams(input.arguments).get("paseoAgent");
  if (!link || !parseAgentDeepLink(link)) {
    return;
  }
  openAgentLink(link);
}

interface WindowsNotificationCloseInput {
  reason: NotificationCloseEventParams["reason"];
  programmatic: boolean;
}

type WindowsNotificationCloseDisposition = "retain" | "acknowledge" | "release";

/** Classify an observed native callback; this policy cannot guarantee that Windows emits one. */
export function classifyWindowsNotificationClose(
  input: WindowsNotificationCloseInput,
): WindowsNotificationCloseDisposition {
  // A timed-out banner remains clickable in Notification Center, so retain its listener.
  if (input.reason === "timedOut") return "retain";
  if (!input.programmatic && input.reason === "userCanceled") return "acknowledge";
  return "release";
}

interface WindowsNotificationActivation {
  type: string;
  arguments: string;
}

/** Share one opener between instance clicks and durable activations, which can both report a tap. */
export function createWindowsAgentNotificationOpener(openAgentLink: (url: string) => void) {
  const handledTags = new Set<string>();

  return function open(input: WindowsNotificationActivation): void {
    openWindowsAgentNotification(input, (url) => {
      const tag = new URLSearchParams(input.arguments).get("tag");
      if (tag) {
        if (handledTags.has(tag)) {
          return;
        }
        handledTags.add(tag);
        // Only recent clicks can have a second callback pending. Bound this
        // metadata independently of the retained Notification Center objects.
        if (handledTags.size > 256) {
          const oldest = handledTags.values().next().value;
          if (oldest) {
            handledTags.delete(oldest);
          }
        }
      }
      openAgentLink(url);
    });
  };
}
