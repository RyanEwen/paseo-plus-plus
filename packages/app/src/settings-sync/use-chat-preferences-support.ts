import { selectChatPreferencesSupport } from "@/appearance/chat-preferences-support";
import { useSessionStore } from "@/stores/session-store";
import { useSettingsSyncState } from "./bootstrap";

/**
 * Whether chat display and send shortcut edits can be saved now: always on a device with no
 * settings host, otherwise only when the selected host supports them.
 */
export function useChatPreferencesSupport(): boolean {
  const { selectedHost } = useSettingsSyncState();
  return useSessionStore((state) => selectChatPreferencesSupport(state, selectedHost));
}
