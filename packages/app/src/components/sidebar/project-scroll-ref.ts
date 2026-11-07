/**
 * Wrap Reanimated's animated ref as a React callback ref that also exposes `.current`.
 *
 * Nestable draggable lists read `.current` from the scroll container's ref as well as invoking it,
 * so the callback alone would hide the attached node from their autoscroll.
 */
export function createProjectScrollRef<T>(
  register: ((node: T | null) => unknown) & { current: T | null },
) {
  let attached: T | null = null;
  const ref = (node: T | null): void => {
    attached = node;
    register(node);
  };
  Object.defineProperty(ref, "current", { get: () => attached });
  return ref as typeof ref & { readonly current: T | null };
}
