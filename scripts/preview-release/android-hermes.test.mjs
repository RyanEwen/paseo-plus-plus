import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

/** Run swap_used_bytes from the driver's sourced helper against a fixture swap table. */
function swapUsedBytes(swapFile, rows) {
  const helper = fileURLToPath(new URL("./android-hermes-swap.sh", import.meta.url));
  return spawnSync("bash", ["-c", 'source "$1"; swap_used_bytes "$2"', "bash", helper, swapFile], {
    encoding: "utf8",
    input: rows,
  });
}

test(
  "Hermes cleanup reads the temporary swap file's used bytes from the swap table",
  { skip: process.platform === "win32" },
  () => {
    const swapFile = "/home/runner/work/_temp/paseo-hermes.swap";
    const rows = [
      "/swapfile                                   4294967296",
      `${swapFile}  17179869184`,
      "/dev/zram0                                  0",
      "",
    ].join("\n");

    const found = swapUsedBytes(swapFile, rows);
    assert.equal(found.status, 0, found.stderr);
    assert.equal(found.stdout, "17179869184\n");

    // Inactive swap is reported by the exit status, not as zero bytes in use.
    const missing = swapUsedBytes(swapFile, "/swapfile  4294967296\n");
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stdout, "");

    // A name that only shares a prefix is a different swap file.
    const prefixed = swapUsedBytes(swapFile, `${swapFile}.old  1024\n`);
    assert.notEqual(prefixed.status, 0);
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
