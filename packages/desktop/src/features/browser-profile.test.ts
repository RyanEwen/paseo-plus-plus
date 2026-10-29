import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  clearPaseoBrowserProfile,
  configurePaseoBrowserIdentity,
  getLegacyPaseoBrowserProfileSession,
  getPaseoBrowserProfileSessions,
  listPaseoBrowserProfileGuests,
  readLegacyPaseoBrowserIds,
} from "./browser-profile.js";

class FakeProfileSession {
  public readonly storageClears: unknown[] = [];
  public cacheClears = 0;
  public authClears = 0;
  public storageClear: Promise<void> = Promise.resolve();
  public clearStorageData(options: unknown): Promise<void> {
    this.storageClears.push(options);
    return this.storageClear;
  }

  public clearCache(): Promise<void> {
    this.cacheClears += 1;
    return Promise.resolve();
  }

  public clearAuthCache(): Promise<void> {
    this.authClears += 1;
    return Promise.resolve();
  }
}

class FakeBrowserApplication {
  public readonly userAgentWrites: string[] = [];

  public constructor(private fallback = "") {}

  public get userAgentFallback(): string {
    return this.fallback;
  }

  public set userAgentFallback(value: string) {
    this.fallback = value;
    this.userAgentWrites.push(value);
  }
}

describe("browser application identity", () => {
  test("sets the Chromium fallback while retaining the exact branded main UI identity", () => {
    const originalIdentity =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Paseo++/0.12.0-preview.65535 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";
    const app = new FakeBrowserApplication(originalIdentity);

    const mainWindowUserAgent = configurePaseoBrowserIdentity({
      app,
      appName: "Paseo++",
      appVersion: "0.12.0-preview.65535",
      electronVersion: "44.5.1",
    });

    expect(app.userAgentFallback).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36",
    );
    expect(mainWindowUserAgent).toBe(originalIdentity);
  });

  test.each([
    {
      appName: "Paseo",
      appVersion: "1.2.3",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) Paseo/1.2.3 Chrome/151.2.3.4 Electron/43.2.1 Safari/537.36",
    },
    {
      appName: "Paseo++",
      appVersion: "2.0.0-preview.7",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) Paseo++/2.0.0-preview.7 Chrome/151.2.3.4 Electron/43.2.1 Safari/537.36",
    },
    {
      appName: "Paseo++ Debug",
      appVersion: "3.1.4",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) Paseo++Debug/3.1.4 Chrome/151.2.3.4 Electron/43.2.1 Safari/537.36",
    },
    {
      appName: "QA Browser",
      appVersion: "4.0.0-test.9",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) QABrowser/4.0.0-test.9 Chrome/151.2.3.4 Electron/43.2.1 Safari/537.36",
    },
  ])("retains the actual engine and OS for $appName", ({ appName, appVersion, userAgent }) => {
    const app = new FakeBrowserApplication();
    app.userAgentFallback = userAgent;

    configurePaseoBrowserIdentity({
      app,
      appName,
      appVersion,
      electronVersion: "43.2.1",
    });

    expect(app.userAgentFallback).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) Chrome/151.2.3.4 Safari/537.36",
    );
  });

  test("preserves other products and nonmatching names or versions", () => {
    const app = new FakeBrowserApplication();
    app.userAgentFallback =
      "Mozilla/5.0 MyPaseo++/1.2.3 Paseo/1.2.3 Paseo++/1.2.30 Paseo++/1.2.3-extra Electron/44.5.10 NotElectron/44.5.1 Paseo++/1.2.3 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36";

    configurePaseoBrowserIdentity({
      app,
      appName: "Paseo++",
      appVersion: "1.2.3",
      electronVersion: "44.5.1",
    });

    expect(app.userAgentFallback).toBe(
      "Mozilla/5.0 MyPaseo++/1.2.3 Paseo/1.2.3 Paseo++/1.2.30 Paseo++/1.2.3-extra Electron/44.5.10 NotElectron/44.5.1 Chrome/152.0.7977.130 Safari/537.36",
    );
  });

  test("repeated setup keeps the same identity without another UA override", () => {
    const app = new FakeBrowserApplication(
      "Mozilla/5.0 Paseo/1.2.3 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36",
    );
    const input = {
      app,
      appName: "Paseo",
      appVersion: "1.2.3",
      electronVersion: "44.5.1",
    };

    const mainWindowUserAgent = configurePaseoBrowserIdentity(input);
    configurePaseoBrowserIdentity(input);

    expect(app.userAgentFallback).toBe("Mozilla/5.0 Chrome/152.0.7977.130 Safari/537.36");
    expect(app.userAgentWrites).toEqual(["Mozilla/5.0 Chrome/152.0.7977.130 Safari/537.36"]);
    expect(mainWindowUserAgent).toBe(
      "Mozilla/5.0 Paseo/1.2.3 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36",
    );
  });

  test("leaves an existing Chromium identity unchanged", () => {
    const app = new FakeBrowserApplication("Mozilla/5.0 Chrome/153.1.2.3 Safari/537.36");

    configurePaseoBrowserIdentity({
      app,
      appName: "Paseo++",
      appVersion: "1.2.3",
      electronVersion: "44.5.1",
    });

    expect(app.userAgentFallback).toBe("Mozilla/5.0 Chrome/153.1.2.3 Safari/537.36");
    expect(app.userAgentWrites).toEqual([]);
  });

  test("startup establishes the permanent fallback before ready or any contents creation", () => {
    const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    const configuration = "const mainWindowUserAgent = configurePaseoBrowserIdentity({";
    const configurationIndex = source.indexOf(configuration);

    expect(configurationIndex).toBeGreaterThan(source.indexOf("app.setName(APP_NAME);"));
    expect(configurationIndex).toBeLessThan(source.indexOf("new BrowserWindow("));
    expect(configurationIndex).toBeLessThan(source.indexOf("await app.whenReady();"));
    expect(configurationIndex).toBeLessThan(source.indexOf("await registerBrowserExtensions();"));
    expect(source.split(configuration)).toHaveLength(2);
    expect(source).not.toContain("configurePaseoBrowserProfileIdentity");
  });

  test("every main UI window receives the retained identity before dev or packaged navigation", () => {
    const source = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    const windowSource = source.slice(
      source.indexOf("async function createWindow("),
      source.indexOf("function ownedDesktopWindow("),
    );
    const mainIdentity = "mainWindow.webContents.setUserAgent(mainWindowUserAgent);";
    const identityIndex = windowSource.indexOf(mainIdentity);

    expect(identityIndex).toBeGreaterThan(
      windowSource.indexOf("const mainWindow = new BrowserWindow("),
    );
    expect(identityIndex).toBeLessThan(windowSource.indexOf("options.onCreated?.(webContentsId);"));
    expect(identityIndex).toBeLessThan(
      windowSource.indexOf("await mainWindow.loadURL(initialUrl);"),
    );
    expect(identityIndex).toBeLessThan(
      windowSource.indexOf("await mainWindow.loadURL(`${APP_SCHEME}://app${options.initialRoute"),
    );
    expect(windowSource.split(mainIdentity)).toHaveLength(2);
  });
});

class FakeLiveGuest {
  public reloads = 0;

  public constructor(
    public readonly id: number,
    private readonly destroyed = false,
    private readonly reloadError: Error | null = null,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public reload(): void {
    if (this.reloadError) {
      throw this.reloadError;
    }
    this.reloads += 1;
  }
}

class FakeWebContents extends FakeLiveGuest {
  public constructor(
    id: number,
    public readonly session: object,
    private readonly type: string,
    destroyed = false,
  ) {
    super(id, destroyed);
  }

  public getType(): string {
    return this.type;
  }
}

describe("listPaseoBrowserProfileGuests", () => {
  test("returns every live native browser, webview and popup in the shared profile", () => {
    const profileSession = {};
    const firstWindowGuest = new FakeWebContents(1, profileSession, "webview");
    const secondWindowGuest = new FakeWebContents(2, profileSession, "webview");
    const foreignProfileGuest = new FakeWebContents(3, {}, "webview");
    const popupWindow = new FakeWebContents(4, profileSession, "window");
    const destroyedGuest = new FakeWebContents(5, profileSession, "webview", true);
    const nativeView = new FakeWebContents(6, profileSession, "browserView");
    const foreignNativeView = new FakeWebContents(7, {}, "browserView");

    const guests = listPaseoBrowserProfileGuests({
      profileSession,
      webContents: [
        firstWindowGuest,
        secondWindowGuest,
        foreignProfileGuest,
        popupWindow,
        destroyedGuest,
        nativeView,
        foreignNativeView,
      ],
    });

    expect(guests).toEqual([firstWindowGuest, secondWindowGuest, popupWindow, nativeView]);
  });
});

describe("legacy browser profiles", () => {
  test("accepts only unique saved browser ids and resolves their old partitions", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const fallbackId = "1700000000000-abcd";
    const browserIds = readLegacyPaseoBrowserIds([uuid, fallbackId, uuid, "not-a-browser-id", 123]);
    const partitions: string[] = [];
    const sessions = getPaseoBrowserProfileSessions(
      {
        fromPartition: (partition) => {
          partitions.push(partition);
          return new FakeProfileSession();
        },
      },
      browserIds,
    );

    expect(partitions).toEqual([
      "persist:paseo-browser",
      `persist:paseo-browser-${uuid}`,
      `persist:paseo-browser-${fallbackId}`,
    ]);
    expect(sessions).toHaveLength(3);
  });

  test("resolves one valid legacy profile for tab-close cleanup", () => {
    const partitions: string[] = [];
    const sessions = {
      fromPartition: (partition: string) => {
        partitions.push(partition);
        return new FakeProfileSession();
      },
    };

    expect(getLegacyPaseoBrowserProfileSession(sessions, "1700000000000-abcd")).not.toBeNull();
    expect(getLegacyPaseoBrowserProfileSession(sessions, "invalid")).toBeNull();
    expect(partitions).toEqual(["persist:paseo-browser-1700000000000-abcd"]);
  });
});

describe("clearPaseoBrowserProfile", () => {
  test("clears site data, HTTP cache, and auth before reloading live guests", async () => {
    const profile = new FakeProfileSession();
    const legacyProfile = new FakeProfileSession();
    let finishStorageClear: (() => void) | null = null;
    profile.storageClear = new Promise((resolve) => {
      finishStorageClear = resolve;
    });
    const firstGuest = new FakeLiveGuest(1);
    const secondGuest = new FakeLiveGuest(2);

    const clearing = clearPaseoBrowserProfile({
      profileSessions: [profile, legacyProfile],
      listGuests: () => [firstGuest, secondGuest],
      logReloadError: () => {},
    });

    expect(firstGuest.reloads).toBe(0);
    expect(secondGuest.reloads).toBe(0);
    finishStorageClear?.();
    await clearing;

    expect(profile.storageClears).toEqual([
      {
        storages: [
          "cookies",
          "filesystem",
          "indexdb",
          "localstorage",
          "serviceworkers",
          "cachestorage",
          "shadercache",
        ],
      },
    ]);
    expect(profile.cacheClears).toBe(1);
    expect(profile.authClears).toBe(1);
    expect(legacyProfile.storageClears).toEqual(profile.storageClears);
    expect(legacyProfile.cacheClears).toBe(1);
    expect(legacyProfile.authClears).toBe(1);
    expect(firstGuest.reloads).toBe(1);
    expect(secondGuest.reloads).toBe(1);
  });

  test("skips destroyed guests and logs individual reload failures", async () => {
    const profile = new FakeProfileSession();
    const destroyedGuest = new FakeLiveGuest(1, true);
    const reloadError = new Error("guest disappeared");
    const failedGuest = new FakeLiveGuest(2, false, reloadError);
    const reloadErrors: Array<{ guestId: number; error: unknown }> = [];

    await clearPaseoBrowserProfile({
      profileSessions: [profile],
      listGuests: () => [destroyedGuest, failedGuest],
      logReloadError: (guestId, error) => reloadErrors.push({ guestId, error }),
    });

    expect(destroyedGuest.reloads).toBe(0);
    expect(failedGuest.reloads).toBe(0);
    expect(reloadErrors).toEqual([{ guestId: 2, error: reloadError }]);
  });

  test("propagates clear failures without reloading guests", async () => {
    const profile = new FakeProfileSession();
    const clearError = new Error("profile locked");
    profile.storageClear = Promise.reject(clearError);
    const guest = new FakeLiveGuest(1);

    await expect(
      clearPaseoBrowserProfile({
        profileSessions: [profile],
        listGuests: () => [guest],
        logReloadError: () => {},
      }),
    ).rejects.toBe(clearError);
    expect(guest.reloads).toBe(0);
  });
});
