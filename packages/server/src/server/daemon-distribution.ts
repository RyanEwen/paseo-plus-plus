import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const FORK_DAEMON_PACKAGE = "@ryanewen/paseo-daemon";

/** Installed daemon identity: CLI package, command name and local defaults. */
export interface DaemonDistribution {
  cliPackage: string;
  commandName: string;
  /** Default PASEO_HOME, with a leading ~ for the user's home folder. */
  defaultHome: string;
  defaultPort: number;
}

const manifestNameSchema = z.object({ name: z.string().optional() });

const desktopManifestSchema = z.object({
  name: z.string().optional(),
  paseoPreview: z.boolean().optional(),
});

const upstreamDistribution: DaemonDistribution = {
  cliPackage: "@getpaseo/cli",
  commandName: "paseo",
  defaultHome: "~/.paseo",
  defaultPort: 6767,
};

const forkDistribution: DaemonDistribution = {
  cliPackage: FORK_DAEMON_PACKAGE,
  commandName: "paseo-plus-plus",
  defaultHome: "~/.paseo-plus-plus",
  defaultPort: 6791,
};

const desktopPackageNames = new Set(["@getpaseo/desktop", "paseo-plus-plus"]);

function resolveDesktopManifest(value: unknown): DaemonDistribution | null {
  const manifest = desktopManifestSchema.parse(value);
  if (manifest.paseoPreview) {
    return {
      ...upstreamDistribution,
      defaultHome: "~/.paseo-plus-plus-desktop",
      defaultPort: 6790,
    };
  }
  return null;
}

/** Resolve installed identity from the enclosing package, independent of launch environment overrides. */
export function resolveDaemonDistribution(moduleUrl: string): DaemonDistribution {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  while (path.dirname(directory) !== directory) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      const parsed = manifestNameSchema.parse(value);
      if (parsed.name === FORK_DAEMON_PACKAGE) {
        return forkDistribution;
      }
      if (parsed.name && desktopPackageNames.has(parsed.name)) {
        const desktop = resolveDesktopManifest(value);
        if (desktop) return desktop;
      }
    }
    directory = path.dirname(directory);
  }

  return upstreamDistribution;
}

export const daemonDistribution = resolveDaemonDistribution(import.meta.url);
