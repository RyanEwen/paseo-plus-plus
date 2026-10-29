import type { ReactNode } from "react";
import { createContext, useContext } from "react";
const MessageOuterSpacingContext = createContext(false);

export function MessageOuterSpacingProvider({
  disableOuterSpacing,
  children,
}: {
  disableOuterSpacing: boolean;
  children: ReactNode;
}) {
  return (
    <MessageOuterSpacingContext.Provider value={disableOuterSpacing}>
      {children}
    </MessageOuterSpacingContext.Provider>
  );
}

export function useDisableOuterSpacing(disableOuterSpacing: boolean | undefined) {
  const contextValue = useContext(MessageOuterSpacingContext);
  return disableOuterSpacing ?? contextValue;
}

export const STREAM_METADATA_FONT_SIZE = 13;

/** Shared marker used by message selection and clipboard actions. */
export const MESSAGE_TEXT_DATASET = { messageText: "true" };
