import { useContext, type ReactNode } from "react";
import { ACTUAL_ROW_STYLE, ActualPromptBodyContext } from "./row-content.web";

/**
 * The one element of a prompt row that sticks on web: the message itself. Content the row
 * renders after the message, such as a collapsed turn's summary, stays outside it.
 */
export function ActualPromptBody({ children }: { children: ReactNode }) {
  const registerBody = useContext(ActualPromptBodyContext);
  if (!registerBody) return children;
  return (
    <div ref={registerBody} data-actual-prompt-content style={ACTUAL_ROW_STYLE}>
      {children}
    </div>
  );
}
