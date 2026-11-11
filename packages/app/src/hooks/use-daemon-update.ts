import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";
import type { HostProfile } from "@/types/host-connection";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  createDaemonUpdatePort,
  runDaemonUpdateAttempt,
  type DaemonUpdateOutcome,
  type DaemonUpdateState,
} from "@/hosts/daemon-update";

const IDLE: DaemonUpdateState = { status: "idle" };

/**
 * Own one host update at a time for a surface (Host Settings or the sidebar host menu).
 * `handleUpdate(host)` runs the shared confirmation, progress and replacement-worker
 * verification and resolves with the attempt's outcome; a second press while one runs resolves
 * `"duplicate"` without opening another confirmation. `reset()` clears a settled outcome before
 * the surface presents a new attempt. Unmount detaches feedback; it does not cancel an
 * acknowledged host update.
 */
export function useDaemonUpdate() {
  const { t } = useTranslation();
  const [updateState, setUpdateState] = useState<DaemonUpdateState>(IDLE);
  const isMountedRef = useRef(true);
  const requestInProgressRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleUpdate = useCallback(
    async (host: Pick<HostProfile, "serverId" | "label">): Promise<DaemonUpdateOutcome> => {
      // Keep the guard synchronous so repeated presses cannot open overlapping confirmations.
      if (requestInProgressRef.current) return "duplicate";
      requestInProgressRef.current = true;
      try {
        const runtime = getHostRuntimeStore();
        const client = runtime.getClient(host.serverId);
        return await runDaemonUpdateAttempt({
          host,
          port: client ? createDaemonUpdatePort(client) : null,
          isConnected: () => isHostRuntimeConnected(runtime.getSnapshot(host.serverId)),
          confirm: confirmDialog,
          t,
          onState: setUpdateState,
          isActive: () => isMountedRef.current,
        });
      } finally {
        requestInProgressRef.current = false;
      }
    },
    [t],
  );

  const reset = useCallback(() => {
    if (!requestInProgressRef.current) setUpdateState(IDLE);
  }, []);

  return { updateState, handleUpdate, reset };
}
