import { createStore, type StoreApi } from "zustand/vanilla";
import type { AndroidUpdateDownloadProgress, AndroidUpdaterNative } from "./native-contract";
import type { AndroidUpdate } from "./releases";
import { describeUpdateFailure } from "./errors";

export type AndroidUpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "verifying"
  | "permission"
  | "installer"
  | "error";

/**
 * Minimum gap between automatic checks. GitHub allows 60 unauthenticated API requests per hour
 * per network, shared by every device behind it, so resume bursts must not each send a request.
 */
export const AUTOMATIC_CHECK_MIN_GAP_MS = 15 * 60 * 1000;

/** Automatic checks come from startup, resume and the interval; manual ones from a button. */
export type AndroidUpdateCheckIntent = "automatic" | "manual";

/** A check or download is running, so no other update operation may start. */
export function isAndroidUpdateBusy(status: AndroidUpdateStatus): boolean {
  return status === "checking" || isAndroidUpdateTransferring(status);
}

/** The APK is downloading or being verified. */
export function isAndroidUpdateTransferring(status: AndroidUpdateStatus): boolean {
  return status === "downloading" || status === "verifying";
}

/** Release discovery and checksum lookup, injected so tests need no network. */
export interface AndroidUpdateReleasesPort {
  /** The newest published preview newer than the installed version code, or null. */
  find(installedCode: number): Promise<AndroidUpdate | null>;
  /** The APK's SHA-256 from the release's SHA256SUMS; throws when absent or ambiguous. */
  readChecksum(update: AndroidUpdate): Promise<string>;
}

export interface AndroidUpdaterDeps {
  /** Null outside Android fork previews; the updater then never does anything. */
  native: AndroidUpdaterNative | null;
  releases: AndroidUpdateReleasesPort;
  /** Current time in milliseconds, for throttling automatic checks. */
  now(): number;
}

export interface AndroidUpdateState {
  /** Whether this build can install its own updates at all. */
  available: boolean;
  status: AndroidUpdateStatus;
  update: AndroidUpdate | null;
  /** Version code of the APK already downloaded and verified, so install can skip the download. */
  preparedVersionCode: number | null;
  error: string | null;
  progress: AndroidUpdateDownloadProgress | null;
  /** When the most recent check request started, successful or not. */
  lastCheckedAt: number | null;
  check: (options: { intent: AndroidUpdateCheckIntent }) => Promise<void>;
  install: () => Promise<void>;
}

export type AndroidUpdater = StoreApi<AndroidUpdateState>;

/** Statuses an automatic check must not overwrite: pending user actions and visible retry errors. */
function preservesUserAction(status: AndroidUpdateStatus): boolean {
  return status === "permission" || status === "installer" || status === "error";
}

/** A check started within the automatic minimum gap. Manual checks ignore this. */
function checkedRecently(lastCheckedAt: number | null, currentTime: number): boolean {
  return lastCheckedAt !== null && currentTime - lastCheckedAt < AUTOMATIC_CHECK_MIN_GAP_MS;
}

/**
 * Create the shared update operation for Settings and the sidebar. Checks and downloads never
 * overlap; automatic check failures are silent so a background request cannot replace visible state.
 */
export function createAndroidUpdater({
  native,
  releases,
  now,
}: AndroidUpdaterDeps): AndroidUpdater {
  return createStore<AndroidUpdateState>((set, get) => {
    /** Download and verify the APK natively, publishing progress for this version only. */
    async function prepare(updaterNative: AndroidUpdaterNative, update: AndroidUpdate) {
      const sha256 = await releases.readChecksum(update);
      // Scope native events to this download and remove the listener on every terminal path.
      let acceptingProgress = true;
      const subscription = updaterNative.addListener("downloadProgress", (progress) => {
        if (!acceptingProgress || progress.versionCode !== update.versionCode) return;
        set({ status: progress.phase, progress });
      });
      try {
        await updaterNative.download(update.url, sha256, update.versionCode);
      } finally {
        acceptingProgress = false;
        subscription.remove();
      }
      set({ preparedVersionCode: update.versionCode });
    }

    return {
      available: native !== null,
      status: "idle",
      update: null,
      preparedVersionCode: null,
      error: null,
      progress: null,
      lastCheckedAt: null,

      async check({ intent }) {
        const previous = get();
        if (!native || isAndroidUpdateBusy(previous.status)) return;
        if (intent === "automatic") {
          if (preservesUserAction(previous.status)) return;
          if (checkedRecently(previous.lastCheckedAt, now())) return;
        }
        set({ status: "checking", error: null, progress: null, lastCheckedAt: now() });
        try {
          const update = await releases.find(native.getVersionCode());
          set({ update, status: update ? "available" : "current" });
        } catch (error) {
          if (intent === "automatic") {
            set({ status: previous.status });
            return;
          }
          set({
            status: "error",
            error: describeUpdateFailure(error, "Unable to check for updates"),
          });
        }
      },

      async install() {
        const { update, status, preparedVersionCode } = get();
        if (!native || !update || isAndroidUpdateBusy(status)) return;
        set({ status: "downloading", error: null, progress: null });
        try {
          if (preparedVersionCode !== update.versionCode) {
            await prepare(native, update);
          }
          const result = await native.install(update.versionCode);
          set({
            status: result === "permission_required" ? "permission" : "installer",
            progress: null,
          });
        } catch (error) {
          set({
            status: "error",
            progress: null,
            preparedVersionCode: null,
            error: describeUpdateFailure(error, "Unable to install update"),
          });
        }
      },
    };
  });
}
