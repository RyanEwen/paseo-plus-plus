import assert from "node:assert/strict";
import { test } from "vitest";
import { getAndroidCompilerBudget } from "./android-compiler-budget.mjs";

test("Hermes capacity preserves disk and runner RAM under ancestor limits", () => {
  const GiB = 1024 ** 3;
  assert.deepEqual(getAndroidCompilerBudget(28 * GiB, 15 * GiB, ["max"]), {
    ram: 12 * GiB,
    swap: 16 * GiB,
  });
  assert.equal(getAndroidCompilerBudget(28 * GiB, 13 * GiB, ["max"]).ram, 10 * GiB);
  assert.throws(() => getAndroidCompilerBudget(28 * GiB, 13 * GiB, [12 * GiB]), /Finite ancestor/);
  assert.throws(() => getAndroidCompilerBudget(27 * GiB, 15 * GiB), /28 GiB free/);
  assert.throws(() => getAndroidCompilerBudget(28 * GiB, 6 * GiB), /Insufficient RAM/);
  assert.throws(() => getAndroidCompilerBudget(28 * GiB, 15 * GiB, ["unknown"]), /Finite ancestor/);
});
