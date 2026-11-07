import { z } from "zod";

import path from "node:path";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";

const IconSchema = z.union([z.string(), z.record(z.string(), z.string())]);
const ToolbarActionSchema = z.object({
  default_popup: z.string().optional(),
  default_title: z.string().optional(),
  default_icon: IconSchema.optional(),
});
const ActionSchema = z.object({ default_popup: z.string().optional() });
const ManifestSchema = z.object({
  action: ActionSchema.optional(),
  browser_action: ActionSchema.optional(),
  page_action: ActionSchema.optional(),
});

const ToolbarManifestSchema = z.object({
  icons: z.record(z.string(), z.string()).optional(),
  action: ToolbarActionSchema.optional(),
  browser_action: ToolbarActionSchema.optional(),
  page_action: ToolbarActionSchema.optional(),
});

/** Resolve only a popup packaged inside this extension, never a remote or sibling origin. */
export function getExtensionPopupUrl(id: string, manifest: unknown): string | null {
  const parsed = ManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return null;
  }
  const action = parsed.data.action ?? parsed.data.browser_action ?? parsed.data.page_action;
  const popup = action?.default_popup;
  if (!popup) {
    return null;
  }
  if (!URL.canParse(popup, `chrome-extension://${id}/`)) {
    return null;
  }
  const url = new URL(popup, `chrome-extension://${id}/`);
  if (url.protocol !== "chrome-extension:" || url.hostname !== id) {
    return null;
  }
  return url.href;
}

/** Use packaged action titles/icons; extension-provided badges have a separate runtime store. */
export function getExtensionToolbarMetadata(
  manifest: unknown,
  name: string,
): { title: string; iconPath: string | null } {
  const parsed = ToolbarManifestSchema.safeParse(manifest);
  if (!parsed.success) return { title: name, iconPath: null };
  const action = parsed.data.action ?? parsed.data.browser_action ?? parsed.data.page_action;
  const title = action?.default_title;
  // Localized titles need the extension's message catalog, which Paseo does not resolve.
  const usableTitle = title && !title.startsWith("__MSG_") ? title : name;
  const iconPath = selectIconPath(action?.default_icon ?? parsed.data.icons);
  return { title: usableTitle, iconPath };
}

/** Use a single icon path as is; otherwise the smallest size of at least 32px, else the largest. */
function selectIconPath(icon: string | Record<string, string> | undefined): string | null {
  if (typeof icon === "string") {
    return icon;
  }
  if (icon === undefined) {
    return null;
  }
  const sizes = Object.keys(icon)
    .map(Number)
    .filter((declared) => Number.isFinite(declared) && declared > 0)
    .sort((a, b) => a - b);
  const size = sizes.find((value) => value >= 32) ?? sizes.at(-1);
  if (size === undefined) {
    return null;
  }
  return icon[String(size)] ?? null;
}

/** Never return bytes from a manifest path outside the installed extension package. */
export async function readExtensionToolbarIcon(
  extensionPath: string,
  iconPath: string | null,
): Promise<Buffer | null> {
  if (!iconPath) return null;
  try {
    const root = await realpath(extensionPath);
    const url = new URL(iconPath, "chrome-extension://package/");
    if (url.protocol !== "chrome-extension:" || url.hostname !== "package") return null;
    const target = await realpath(path.resolve(root, `.${decodeURIComponent(url.pathname)}`));
    const relative = path.relative(root, target);
    if (
      !relative ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1024 * 1024) return null;
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      return bytesRead > 1024 * 1024 ? null : bytes.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
