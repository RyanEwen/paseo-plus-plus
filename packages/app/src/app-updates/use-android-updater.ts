import { createContext, useContext } from "react";
import { useStore } from "zustand";
import { androidUpdaterNative } from "./native";
import { findAndroidUpdate, readApkChecksum, requestUpdateResource } from "./releases";
import { createAndroidUpdater, type AndroidUpdater, type AndroidUpdateState } from "./store";

/** The app's single updater, wired to the native bridge and the fork's GitHub releases. */
export const androidUpdater = createAndroidUpdater({
  native: androidUpdaterNative,
  releases: {
    find: (installedCode) => findAndroidUpdate(installedCode),
    async readChecksum(update) {
      const inventory = await requestUpdateResource(update.checksumUrl);
      return readApkChecksum(inventory, update.filename);
    },
  },
});

const AndroidUpdaterContext = createContext<AndroidUpdater>(androidUpdater);

/** Supplies a different updater to the Settings row and sidebar callout, e.g. one built from fakes. */
export const AndroidUpdaterProvider = AndroidUpdaterContext.Provider;

/** Subscribe to one slice of the current updater's state. */
export function useAndroidUpdater<T>(selector: (state: AndroidUpdateState) => T): T {
  return useStore(useContext(AndroidUpdaterContext), selector);
}
