import type { ReplicaRowExpectation } from "./row-store";

/**
 * Whether a stored row still satisfies a compare-and-apply expectation: an expected payload
 * must match exactly, and an expected absence (`payload: null`) must find no row.
 */
export function matchesRowExpectation(
  current: { payload: string } | undefined,
  expected: ReplicaRowExpectation,
): boolean {
  const expectsAbsence = expected.payload === null;
  if (expectsAbsence) return current === undefined;
  return current !== undefined && current.payload === expected.payload;
}
