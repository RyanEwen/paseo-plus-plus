import type { AndroidUpdateDownloadProgress, AndroidUpdaterNative } from "../native-contract";
import type { AndroidUpdate } from "../releases";
import {
  createAndroidUpdater,
  type AndroidUpdateReleasesPort,
  type AndroidUpdater,
} from "../store";

export const INSTALLED_VERSION_CODE = 1_000_000_013;
export const VALID_SHA256 = "a".repeat(64);

/** A published preview one build newer than {@link INSTALLED_VERSION_CODE}. */
export function buildAndroidUpdate(build = 14): AndroidUpdate {
  const base = `https://github.com/RyanEwen/paseo-plus-plus/releases/download/v0.11.1-preview.${build}`;
  return {
    version: `0.11.1-preview.${build}`,
    versionCode: 1_000_000_000 + build,
    url: `${base}/paseo.apk`,
    checksumUrl: `${base}/SHA256SUMS`,
    filename: "paseo.apk",
  };
}

type InstallResult = Awaited<ReturnType<AndroidUpdaterNative["install"]>>;

/**
 * In-memory Android bridge. Downloads resolve immediately unless {@link holdDownloads} is set;
 * progress is emitted to the listeners the updater registered.
 */
export class FakeAndroidUpdaterNative implements AndroidUpdaterNative {
  versionCode = INSTALLED_VERSION_CODE;
  downloads: { url: string; sha256: string; versionCode: number }[] = [];
  installs: number[] = [];
  removedListeners = 0;
  /** Results returned by successive install calls; "installer_opened" once exhausted. */
  installResults: (InstallResult | Error)[] = [];
  /** Failures thrown by successive download calls. */
  downloadFailures: Error[] = [];
  holdDownloads = false;
  private listeners = new Set<(progress: AndroidUpdateDownloadProgress) => void>();
  private pendingDownloads: (() => void)[] = [];

  getVersionCode(): number {
    return this.versionCode;
  }

  addListener(
    _name: "downloadProgress",
    handler: (progress: AndroidUpdateDownloadProgress) => void,
  ) {
    this.listeners.add(handler);
    return {
      remove: () => {
        this.listeners.delete(handler);
        this.removedListeners += 1;
      },
    };
  }

  async download(url: string, sha256: string, versionCode: number): Promise<void> {
    this.downloads.push({ url, sha256, versionCode });
    const failure = this.downloadFailures.shift();
    if (failure) throw failure;
    if (!this.holdDownloads) return;
    await new Promise<void>((resolve) => this.pendingDownloads.push(resolve));
  }

  async install(versionCode: number): Promise<InstallResult> {
    this.installs.push(versionCode);
    const result = this.installResults.shift() ?? "installer_opened";
    if (result instanceof Error) throw result;
    return result;
  }

  /** Deliver a native progress event to every registered listener. */
  emitProgress(progress: AndroidUpdateDownloadProgress): void {
    for (const listener of this.listeners) listener(progress);
  }

  /** Complete every held download. */
  finishDownloads(): void {
    for (const resolve of this.pendingDownloads.splice(0)) resolve();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Release port that answers from in-memory values and records how often it was asked. */
export class FakeAndroidUpdateReleases implements AndroidUpdateReleasesPort {
  next: AndroidUpdate | null | Error = buildAndroidUpdate();
  checksum: string | Error = VALID_SHA256;
  finds = 0;
  checksumReads = 0;
  private held: ((value: AndroidUpdate | null) => void) | null = null;
  holdFinds = false;

  async find(): Promise<AndroidUpdate | null> {
    this.finds += 1;
    if (this.holdFinds) {
      return new Promise((resolve) => {
        this.held = resolve;
      });
    }
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }

  async readChecksum(): Promise<string> {
    this.checksumReads += 1;
    if (this.checksum instanceof Error) throw this.checksum;
    return this.checksum;
  }

  /** Resolve a held find with the given result. */
  finishFind(value: AndroidUpdate | null): void {
    this.held?.(value);
    this.held = null;
  }
}

/** A clock tests advance by hand. */
export class ManualClock {
  time = Date.UTC(2026, 10, 7, 12);

  now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}

/** An updater built from fresh fakes, with the fakes exposed for driving and assertions. */
export function createFakeAndroidUpdater(): {
  updater: AndroidUpdater;
  native: FakeAndroidUpdaterNative;
  releases: FakeAndroidUpdateReleases;
  clock: ManualClock;
} {
  const native = new FakeAndroidUpdaterNative();
  const releases = new FakeAndroidUpdateReleases();
  const clock = new ManualClock();
  return {
    updater: createAndroidUpdater({ native, releases, now: clock.now }),
    native,
    releases,
    clock,
  };
}
