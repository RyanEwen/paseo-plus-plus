import { z } from "zod";

/** Must match the normal fork NSIS appId in electron-builder.preview.yml. */
export const WINDOWS_FORK_APP_ID = "sh.paseo.plusplus.desktop";

const distributionMetadataSchema = z.object({
  paseoPreview: z.boolean().default(false),
});

/** Names and OS registration shared by every desktop identity. */
interface DesktopIdentity {
  appName: string;
  /** Linux .desktop entry name; its basename is also the window class. */
  desktopName: string;
}

/**
 * Installed desktop identity. Preview builds carry their own Windows AppUserModelID and bundled
 * daemon defaults; upstream builds leave those to Electron and the daemon.
 */
export type DesktopDistribution =
  | (DesktopIdentity & {
      isPreview: true;
      windowsAppUserModelId: string;
      /** Bundled daemon home, relative to the user's home folder. */
      daemonHomeName: string;
      /** Bundled daemon listen address. */
      daemonListen: string;
    })
  | (DesktopIdentity & {
      isPreview: false;
      windowsAppUserModelId: null;
      daemonHomeName: null;
      daemonListen: null;
    });

/** Release feed selection for electron-updater. */
export interface DesktopUpdateChannel {
  allowPrerelease: boolean;
  channel: "preview" | "beta" | "latest";
}

/** Resolve packaged identity without changing the renderer's storage origin. */
export function resolveDesktopDistribution(metadata: unknown): DesktopDistribution {
  const { paseoPreview } = distributionMetadataSchema.parse(metadata);
  if (paseoPreview) {
    return {
      isPreview: true,
      // The app name also names the profile folder, so the fork starts from a fresh profile
      // independent of upstream and legacy preview installs.
      appName: "Paseo++",
      windowsAppUserModelId: WINDOWS_FORK_APP_ID,
      desktopName: "paseo-plus-plus.desktop",
      daemonHomeName: ".paseo-plus-plus-desktop",
      daemonListen: "127.0.0.1:6790",
    };
  }

  return {
    isPreview: false,
    appName: "Paseo",
    windowsAppUserModelId: null,
    desktopName: "Paseo.desktop",
    daemonHomeName: null,
    daemonListen: null,
  };
}

// The same package-relative path works in source, dist, and the packaged asar.
const packageMetadata = require("../package.json");
export const desktopDistribution = resolveDesktopDistribution(packageMetadata);

/** Preview installs always follow the fork's custom channel, regardless of saved settings. */
export function resolveDesktopUpdateChannel({
  isPreview,
  releaseChannel,
}: {
  isPreview: boolean;
  releaseChannel: "stable" | "beta";
}): DesktopUpdateChannel {
  if (isPreview) {
    return { allowPrerelease: true, channel: "preview" };
  }

  return {
    allowPrerelease: releaseChannel === "beta",
    channel: releaseChannel === "beta" ? "beta" : "latest",
  };
}
