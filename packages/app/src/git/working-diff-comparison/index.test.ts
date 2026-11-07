import { describe, expect, it } from "vitest";
import {
  createInMemoryKeyValueStorage,
  type InMemoryKeyValueStorage,
} from "@/hooks/use-settings/fakes";
import { DEFAULT_CLIENT_SETTINGS } from "@/hooks/use-settings/storage";
import { createWorkingDiffComparisonStore, expireWorkingDiffComparisonsInStore } from "./index";
import { resolveWorkingDiffComparisonFromState, workingDiffComparisonPolicy } from "./state";

const STORAGE_KEY = "working-diff-comparisons";
const checkout = { serverId: "server-1", workspaceId: "workspace-1", cwd: "/repo" };
const defaultPolicy = workingDiffComparisonPolicy(DEFAULT_CLIENT_SETTINGS);
const automaticPolicy = { ...defaultPolicy, autoSwitch: true };

/** In-memory storage that also records every write, so tests can prove a write did not happen. */
function createRecordingStorage(): InMemoryKeyValueStorage & { writes: string[] } {
  const backing = createInMemoryKeyValueStorage();
  const writes: string[] = [];
  return {
    ...backing,
    writes,
    async setItem(key, value) {
      writes.push(value);
      await backing.setItem(key, value);
    },
  };
}

function storedOverrides(storage: InMemoryKeyValueStorage): unknown {
  const raw = storage.entries.get(STORAGE_KEY);
  return raw === undefined ? undefined : JSON.parse(raw).state.overrides;
}

describe("working diff comparison store", () => {
  it("restores the selected comparison after the app reloads", async () => {
    const storage = createInMemoryKeyValueStorage();
    const source = createWorkingDiffComparisonStore(storage);
    await source.persist.rehydrate();
    source.getState().select({ ...checkout, comparison: "base", isDirty: false });
    const restored = createWorkingDiffComparisonStore(storage);
    await restored.persist.rehydrate();
    expect(
      resolveWorkingDiffComparisonFromState(restored.getState(), {
        ...checkout,
        policy: defaultPolicy,
        isDirty: true,
      }),
    ).toBe("base");
  });

  it("writes automatic expiry only when a selection actually expires", async () => {
    const storage = createRecordingStorage();
    const store = createWorkingDiffComparisonStore(storage);
    await store.persist.rehydrate();
    store.getState().select({ ...checkout, comparison: "base", isDirty: false });
    const writesAfterSelection = storage.writes.length;

    expireWorkingDiffComparisonsInStore(store, {
      ...checkout,
      isDirty: false,
      policy: automaticPolicy,
    });
    expect(storage.writes).toHaveLength(writesAfterSelection);

    expireWorkingDiffComparisonsInStore(store, {
      ...checkout,
      isDirty: true,
      policy: automaticPolicy,
    });
    expect(storage.writes).toHaveLength(writesAfterSelection + 1);
    expect(storedOverrides(storage)).toEqual({});
  });

  it("keeps selections when automatic switching is off", async () => {
    const storage = createRecordingStorage();
    const store = createWorkingDiffComparisonStore(storage);
    await store.persist.rehydrate();
    store.getState().select({ ...checkout, comparison: "base", isDirty: false });
    const writesAfterSelection = storage.writes.length;

    expireWorkingDiffComparisonsInStore(store, {
      ...checkout,
      isDirty: true,
      policy: defaultPolicy,
    });
    expect(storage.writes).toHaveLength(writesAfterSelection);
    expect(
      resolveWorkingDiffComparisonFromState(store.getState(), {
        ...checkout,
        policy: defaultPolicy,
        isDirty: true,
      }),
    ).toBe("base");
  });
});
