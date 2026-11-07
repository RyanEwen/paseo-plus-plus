import { useCallback, useEffect, useRef } from "react";
import type { ProjectExpansionFollowing } from "./project-expansion-anchor";

/**
 * Own the one expansion the scroll owner is following.
 *
 * @param duration the current transition duration; changing it (motion turned off, reduced
 *   motion) cancels the following, which still commits its toggle.
 * @returns `start(following)` to replace the current following and `cancel()` for user input.
 *   Unmounting disposes the following without toggling.
 */
export function useExpansionFollowing(duration: number) {
  const current = useRef<ProjectExpansionFollowing | null>(null);
  const cancel = useCallback(() => {
    current.current?.cancel();
    current.current = null;
  }, []);
  const start = useCallback(
    (following: ProjectExpansionFollowing) => {
      cancel();
      current.current = following;
    },
    [cancel],
  );

  useEffect(() => {
    cancel();
  }, [cancel, duration]);

  useEffect(
    () => () => {
      current.current?.dispose();
      current.current = null;
    },
    [],
  );

  return { start, cancel };
}
