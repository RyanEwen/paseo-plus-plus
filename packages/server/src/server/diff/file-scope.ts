import type { Comparison } from "./git.js";

/**
 * Narrow a listed comparison to one changed file, or return it unchanged without a scope.
 *
 * The scope is matched literally against each file's destination path after Git has listed the
 * whole comparison, so rename detection and pathspec-looking names behave as in the full diff.
 * Bodies, the total byte budget and the many-file cutoff then count only the scoped file, which
 * gives a single-file diff the budget unrelated changes would otherwise consume.
 */
export function scopeComparisonToFile(
  comparison: Comparison,
  filePath: string | undefined,
): Comparison {
  if (filePath === undefined) {
    return comparison;
  }
  return {
    ...comparison,
    files: comparison.files.filter((file) => file.entry.path === filePath),
  };
}
