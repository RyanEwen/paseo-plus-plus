import type { QueryClient } from "@tanstack/react-query";
import {
  APP_SETTINGS_QUERY_KEY,
  normalizeAppSettings,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { getSettingsReadAvailable } from "@/settings-sync/save-handler";
import type { PreviousAgentsAvailability } from "./previous-agents";

/** Read committed activation authority synchronously; pending/failed/missing reads have no fallback. */
export function readPreviousAgentsAvailability(input: {
  queryClient: QueryClient;
  identity: { serverId: string; workspaceId: string };
}): PreviousAgentsAvailability {
  const current = input.queryClient.getQueryState<AppSettings>(APP_SETTINGS_QUERY_KEY);
  if (!getSettingsReadAvailable() || current?.status !== "success" || current.data == null) {
    return { ...input.identity, readReady: false, enabled: false };
  }
  return {
    ...input.identity,
    readReady: true,
    enabled: normalizeAppSettings(current.data).paseoPlusPlus.previousAgents,
  };
}
