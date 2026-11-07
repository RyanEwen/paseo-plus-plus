import { buildAgentDeepLink, parseAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";

interface WindowsAgentToastInput {
  /** Activation arguments from buildWindowsAgentNotificationArguments. */
  launch: string;
  title: string;
  body: string | undefined;
  iconPath: string | null;
  silent: boolean;
}

interface WindowsNotificationActivation {
  type: string;
  arguments: string;
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
export function buildWindowsAgentNotificationArguments(input: {
  notificationId: string;
  data: Record<string, unknown> | undefined;
}): string | null {
  const serverId = input.data?.serverId;
  const agentId = input.data?.agentId;
  if (typeof serverId !== "string" || typeof agentId !== "string") {
    return null;
  }
  if (!serverId.trim() || !agentId.trim()) {
    return null;
  }

  // The tag correlates instance clicks with durable activations.
  return new URLSearchParams({
    type: "click",
    tag: input.notificationId,
    paseoAgent: buildAgentDeepLink({ serverId, agentId }),
  }).toString();
}

/** Embed the stable chat URL in the toast so activation survives renderer reloads and app restarts. */
export function buildWindowsAgentToast(input: WindowsAgentToastInput): string {
  const launch = escapeXml(input.launch);
  const body = input.body ? `<text>${escapeXml(input.body)}</text>` : "";
  const icon = input.iconPath
    ? `<image placement="appLogoOverride" hint-crop="none" src="${escapeXml(input.iconPath)}"/>`
    : "";
  const audio = input.silent ? '<audio silent="true"/>' : "";
  return `<toast launch="${launch}" activationType="foreground"><visual><binding template="ToastGeneric"><text>${escapeXml(input.title)}</text>${body}${icon}</binding></visual>${audio}</toast>`;
}

/** A timed-out Windows banner is still available to click in Notification Center. */
export function shouldRetainWindowsNotification(reason: string | undefined): boolean {
  return reason === "timedOut";
}

/** Notification Center keeps at most this many toasts per app; older ones cannot be tapped. */
const NOTIFICATION_CENTER_TOAST_LIMIT = 20;

/**
 * Bounds the timed-out notifications kept alive for Notification Center taps.
 * `retain` returns the instances that fell out of the bound, oldest first, so the caller can
 * release them; `release` forgets an instance that was clicked or closed.
 */
export function createTimedOutNotificationRetention<T>(limit = NOTIFICATION_CENTER_TOAST_LIMIT) {
  const retained = new Set<T>();

  return {
    retain(item: T): T[] {
      retained.delete(item);
      retained.add(item);
      const evicted: T[] = [];
      for (const oldest of retained) {
        if (retained.size <= limit) break;
        retained.delete(oldest);
        evicted.push(oldest);
      }
      return evicted;
    },
    release(item: T): void {
      retained.delete(item);
    },
  };
}

/**
 * Share one opener between instance clicks and durable activations, which can both report a tap.
 * Only Paseo chat activations open a link; other Windows notification actions are left alone.
 */
export function createWindowsAgentNotificationOpener(openAgentLink: (url: string) => void) {
  const handledTags = new Set<string>();

  /** Records a tap's tag; false when that tap was already opened. */
  function rememberTag(tag: string): boolean {
    if (handledTags.has(tag)) return false;
    handledTags.add(tag);
    // Only recent clicks can have a second callback pending. Bound this
    // metadata independently of the retained Notification Center objects.
    if (handledTags.size > 256) {
      const oldest = handledTags.values().next().value;
      if (oldest) handledTags.delete(oldest);
    }
    return true;
  }

  return function open(input: WindowsNotificationActivation): void {
    if (input.type !== "click") return;
    const params = new URLSearchParams(input.arguments);
    const link = params.get("paseoAgent");
    if (!link || !parseAgentDeepLink(link)) return;
    const tag = params.get("tag");
    if (tag && !rememberTag(tag)) return;
    openAgentLink(link);
  };
}
