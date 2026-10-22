import { createContext, useContext } from "react";

/** Keep selected-row ownership available without initializing the find widget or host runtime. */
export const SelectedMessage = createContext<string | null>(null);

/** Return the message whose complete contents the current find operation must keep mounted. */
export function useChatFindSelectedMessageId(): string | null {
  return useContext(SelectedMessage);
}
