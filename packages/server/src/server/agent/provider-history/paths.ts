import path from "node:path";

/** True when `child` is `parent` or lies inside it, comparing resolved absolute paths. */
export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** True when `child` lies strictly inside `parent`; the root itself does not count. */
export function strictlyContainsPath(parent: string, child: string): boolean {
  return path.relative(parent, child) !== "" && containsPath(parent, child);
}

/** True when either path contains the other, so the two roots share history files. */
export function pathsOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left);
}
