import { createContext, useCallback, useContext, useLayoutEffect, useState } from "react";

/** Keep selected-row ownership available without initializing the find widget or host runtime. */
export const SelectedMessage = createContext<string | null>(null);

/** Return the message whose complete contents the current find operation must keep mounted. */
export function useChatFindSelectedMessageId(): string | null {
  return useContext(SelectedMessage);
}

interface OriginalMessageSelection {
  id: string;
  scope: string;
  signal: AbortSignal;
}

/** Hold only the current Find generation at its original row. Its signal, scope
 * and active viewport own the exception; disclosure preferences remain separate.
 */
export function useChatFindOriginalMessage(scope: string, active: boolean) {
  const [selection, setSelection] = useState<OriginalMessageSelection | null>(null);
  const select = useCallback(
    (id: string, signal: AbortSignal) => {
      if (!signal.aborted) setSelection({ id, signal, scope });
    },
    [scope],
  );
  useLayoutEffect(() => {
    if (!selection) return;
    const release = () => setSelection((current) => (current === selection ? null : current));
    selection.signal.addEventListener("abort", release, { once: true });
    if (selection.signal.aborted || selection.scope !== scope || !active) release();
    return () => selection.signal.removeEventListener("abort", release);
  }, [selection, scope, active]);
  const current = active && selection?.scope === scope && !selection.signal.aborted;
  return { messageId: current ? selection.id : null, select };
}
