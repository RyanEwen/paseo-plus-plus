import type { ReactNode } from "react";

/** Native rows have no separate sticky body element; the native sticky header owns paint. */
export function ActualPromptBody({ children }: { children: ReactNode }) {
  return children;
}
