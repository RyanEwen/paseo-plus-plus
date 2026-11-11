import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { CheckoutDiffManager } from "../checkout-diff-manager.js";
import { createWorkspaceRuntimeStore } from "../workspace-runtime-store/index.js";
import { isPlatform } from "../../test-utils/platform.js";

interface Checkout {
  cwd: string;
  manager: CheckoutDiffManager;
  git(...args: string[]): string;
}

/** Run against a real repository with one committed README; refreshes are requested explicitly. */
async function withCheckout(run: (checkout: Checkout) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "diff-file-scope-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const manager = new CheckoutDiffManager({
    logger: pino({ level: "silent" }),
    paseoHome: cwd,
    workspaceRuntimeStore: createWorkspaceRuntimeStore(),
    workspaceGitService: {
      async requestWorkingTreeWatch(root) {
        return { repoRoot: root, unsubscribe: async () => {} };
      },
    },
  });
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "README"), "base\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await run({ cwd, manager, git });
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Text of `lineCount` distinct 99-character lines, so patch size tracks content size. */
function textOfLines(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, line) => String(line).padEnd(99, "x")).join("\n");
}

async function readPaths(manager: CheckoutDiffManager, cwd: string, filePath?: string) {
  const snapshot = await manager.read({ cwd, compare: { mode: "uncommitted", filePath } });
  return snapshot.files.map((file) => ({ path: file.path, status: file.status }));
}

test("a single-file scope gets the budget unrelated changes exhaust in the whole diff", async () => {
  await withCheckout(async ({ cwd, manager }) => {
    // Two near-limit files (about 1.01 MB of patch each) leave about 77 KB of the 2 MB total;
    // the 200 KB file then exceeds it in the whole diff but fits on its own.
    await writeFile(join(cwd, "a-large.txt"), textOfLines(10_000));
    await writeFile(join(cwd, "b-large.txt"), textOfLines(10_000));
    await writeFile(join(cwd, "z-small.css"), textOfLines(2_000));

    const whole = await readPaths(manager, cwd);
    expect(whole).toContainEqual({ path: "z-small.css", status: "too_large" });
    expect(await readPaths(manager, cwd, "z-small.css")).toEqual([
      { path: "z-small.css", status: "ok" },
    ]);
  });
});

test("a single-file scope matches one untracked file among others", async () => {
  await withCheckout(async ({ cwd, manager }) => {
    for (const path of ["a.css", "b.ts", "untracked.ts"]) {
      await writeFile(join(cwd, path), `${path}\n`);
    }
    expect(await readPaths(manager, cwd, "untracked.ts")).toEqual([
      { path: "untracked.ts", status: "ok" },
    ]);
  });
});

// Windows cannot create file names containing ":" or "*", so the literal-name fixture, which
// pairs a leading-space name with a pathspec-looking sibling, runs on Linux and macOS only.
test.skipIf(isPlatform("win32")).each([" a.css", ":(glob)*.css"])(
  "a single-file scope matches %s literally",
  async (filePath) => {
    await withCheckout(async ({ cwd, manager }) => {
      for (const path of [" a.css", ":(glob)*.css", "a.css"]) {
        await writeFile(join(cwd, path), `${path}\n`);
      }
      expect(await readPaths(manager, cwd, filePath)).toEqual([{ path: filePath, status: "ok" }]);
    });
  },
);

test("a single-file scope finds a renamed file by its destination", async () => {
  await withCheckout(async ({ cwd, manager, git }) => {
    await writeFile(join(cwd, "old-name.ts"), "export const value = 1;\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "add");
    git("mv", "old-name.ts", "new-name.ts");

    const snapshot = await manager.read({
      cwd,
      compare: { mode: "uncommitted", filePath: "new-name.ts" },
    });
    expect(snapshot.files).toEqual([
      expect.objectContaining({ path: "new-name.ts", oldPath: "old-name.ts" }),
    ]);
  });
});

test("whole and single-file subscriptions are separate targets", async () => {
  await withCheckout(async ({ cwd, manager }) => {
    await writeFile(join(cwd, "a.ts"), "export const a = 1;\n");
    await writeFile(join(cwd, "b.ts"), "export const b = 1;\n");
    const whole = await manager.subscribe({ cwd, compare: { mode: "uncommitted" } }, () => {});
    const scoped = await manager.subscribe(
      { cwd, compare: { mode: "uncommitted", filePath: "b.ts" } },
      () => {},
    );
    expect(manager.getMetrics().checkoutDiffTargetCount).toBe(2);
    expect(whole.initial.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
    expect(scoped.initial.files.map((file) => file.path)).toEqual(["b.ts"]);
    await scoped.unsubscribe();
    await whole.unsubscribe();
  });
});
