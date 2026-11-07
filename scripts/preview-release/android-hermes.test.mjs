import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test(
  "Hermes cleanup reads explicit swap name and used-byte columns",
  { skip: process.platform !== "linux" },
  () => {
    const driver = readFileSync(new URL("./android-hermes.sh", import.meta.url), "utf8");
    const selection = driver.match(/sudo swapon ([^)]*)/);
    assert.ok(selection, "Cleanup must query actual swap activation");
    // Read the real util-linux table without changing any swap or memory settings.
    // Keep its header so an empty swap table still proves the selected column shape.
    const args = selection[1]
      .trim()
      .split(/\s+/)
      .filter((arg) => arg !== "--noheadings");
    const result = spawnSync("/usr/sbin/swapon", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const [header, ...rows] = result.stdout.trim().split(/\n/);
    assert.deepEqual(header.trim().split(/\s+/), ["NAME", "USED"]);
    for (const row of rows) {
      const columns = row.trim().split(/\s+/);
      assert.equal(columns.length, 2);
      assert.match(columns[1], /^\d+$/);
    }
  },
);

test(
  "Hermes receipt distinguishes completion from failure and signal termination",
  { skip: process.platform !== "linux" },
  () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-hermes-receipt-"));
    try {
      for (const command of ["exit 0", "exit 17", "kill -TERM $$"]) {
        const receipt = path.join(directory, "exit.txt");
        rmSync(receipt, { force: true });
        const result = spawnSync(
          "bash",
          [
            fileURLToPath(new URL("./android-hermes-result.sh", import.meta.url)),
            receipt,
            "bash",
            "-c",
            command,
          ],
          { encoding: "utf8" },
        );
        assert.equal(result.status === 0, command === "exit 0");
        assert.equal(readFileSync(receipt, "utf8").trim() === "0", command === "exit 0");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
