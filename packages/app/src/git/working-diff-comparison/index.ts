import { useCallback, useEffect, useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { queryClient } from "@/data/query-client";
import { useAppSettings } from "@/hooks/use-settings";
import { readAppSettingsSnapshot } from "@/hooks/use-settings/snapshot";
import { create } from "zustand";
import {
  expireWorkingDiffComparisonsInState,
  resolveWorkingDiffComparisonFromState,
  selectWorkingDiffComparisonInState,
  WorkingDiffComparisonOverrideSchema,
  workingDiffComparisonPolicy,
  type WorkingDiffComparisonPolicy,
  type WorkingDiffCheckoutIdentity,
  type WorkingDiffComparison,
  type WorkingDiffComparisonState,
} from "./state";

interface WorkingDiffComparisonStore extends WorkingDiffComparisonState {
  select: (
    input: WorkingDiffCheckoutIdentity & {
      comparison: WorkingDiffComparison;
      isDirty: boolean;
    },
  ) => void;
}

const comparisonStateSchema = z.strictObject({
  overrides: z.record(z.string(), WorkingDiffComparisonOverrideSchema),
});

/** Persists manual comparisons independently of tabs so all Changes surfaces share them. */
export function createWorkingDiffComparisonStore(storage: StateStorage = AsyncStorage) {
  return create<WorkingDiffComparisonStore>()(
    persist(
      (set) => ({
        overrides: {},
        select: (input) => set((state) => selectWorkingDiffComparisonInState(state, input)),
      }),
      {
        name: "working-diff-comparisons",
        storage: createValidatedPersistStorage(storage, comparisonStateSchema),
        partialize: ({ overrides }) => ({ overrides }),
      },
    ),
  );
}

type WorkingDiffComparisonStoreApi = ReturnType<typeof createWorkingDiffComparisonStore>;

const useWorkingDiffComparisonStore = createWorkingDiffComparisonStore();

/** The comparison policy for checkout-status boundary updates outside React. */
function currentComparisonPolicy(): WorkingDiffComparisonPolicy {
  return workingDiffComparisonPolicy(readAppSettingsSnapshot(queryClient));
}

/** Shares a hydrated comparison and remembers explicit selections for this workspace. */
export function useWorkingDiffComparison(
  input: WorkingDiffCheckoutIdentity & { isDirty: boolean; statusReady: boolean },
): {
  comparison: WorkingDiffComparison;
  isLoading: boolean;
  selectComparison: (comparison: WorkingDiffComparison) => void;
} {
  const { serverId, workspaceId, cwd, isDirty, statusReady } = input;
  const { settings, isLoading } = useAppSettings();
  const hydrated = useSyncExternalStore(
    useWorkingDiffComparisonStore.persist.onFinishHydration,
    useWorkingDiffComparisonStore.persist.hasHydrated,
    useWorkingDiffComparisonStore.persist.hasHydrated,
  );
  const policy = workingDiffComparisonPolicy(settings);
  const comparison = useWorkingDiffComparisonStore((state) =>
    resolveWorkingDiffComparisonFromState(state, { serverId, workspaceId, cwd, isDirty, policy }),
  );
  // Initial checkout status may arrive before persisted choices hydrate. Reconcile that
  // boundary again once both stores are ready so an expired automatic choice cannot return.
  useEffect(() => {
    if (hydrated && !isLoading && statusReady && policy.autoSwitch) {
      expireWorkingDiffComparisons({ serverId, cwd, isDirty });
    }
  }, [hydrated, isLoading, statusReady, policy.autoSwitch, serverId, cwd, isDirty]);
  const select = useWorkingDiffComparisonStore((state) => state.select);
  const selectComparison = useCallback(
    (next: WorkingDiffComparison) =>
      select({ serverId, workspaceId, cwd, isDirty, comparison: next }),
    [cwd, isDirty, select, serverId, workspaceId],
  );
  return { comparison, selectComparison, isLoading: isLoading || !hydrated };
}

export function selectWorkingDiffComparison(
  input: WorkingDiffCheckoutIdentity & {
    comparison: WorkingDiffComparison;
    isDirty: boolean;
  },
): void {
  useWorkingDiffComparisonStore.getState().select(input);
}

export function resolveWorkingDiffComparison(
  input: WorkingDiffCheckoutIdentity & { isDirty: boolean },
): WorkingDiffComparison {
  return resolveWorkingDiffComparisonFromState(useWorkingDiffComparisonStore.getState(), {
    ...input,
    policy: currentComparisonPolicy(),
  });
}

interface ExpireWorkingDiffComparisonsInput {
  serverId: string;
  cwd: string;
  isDirty: boolean;
}

/** Expire automatic choices for a checkout whose dirtiness changed, using the app settings. */
export function expireWorkingDiffComparisons(input: ExpireWorkingDiffComparisonsInput): void {
  expireWorkingDiffComparisonsInStore(useWorkingDiffComparisonStore, {
    ...input,
    policy: currentComparisonPolicy(),
  });
}

/**
 * Expire `store`'s choices for the checkout when `policy` follows dirtiness. Writes to storage
 * only when a selection actually expires.
 */
export function expireWorkingDiffComparisonsInStore(
  store: WorkingDiffComparisonStoreApi,
  input: ExpireWorkingDiffComparisonsInput & { policy: WorkingDiffComparisonPolicy },
): void {
  if (!input.policy.autoSwitch) {
    return;
  }
  const current = store.getState();
  const next = expireWorkingDiffComparisonsInState(current, input);
  // Persist middleware writes even when a setter returns the existing state. Checkout
  // updates are frequent, so leave storage alone unless a manual selection expired.
  if (next !== current) {
    store.setState(next);
  }
}

export function resetWorkingDiffComparisons(): void {
  useWorkingDiffComparisonStore.setState({ overrides: {} });
}
