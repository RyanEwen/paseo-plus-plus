import { describe, expect, it, vi } from "vitest";
import {
  createPackagedWindowsToastHistory,
  createWindowsToastHistory,
  type WindowsToastHistoryOperation,
  type WindowsToastHistoryRunner,
} from "./windows-toast-history.js";

const packagedWindows = {
  platform: "win32" as const,
  isPackaged: true,
  appUserModelId: "sh.paseo.plusplus.desktop",
  executable: "C:\\Program Files\\Paseo++\\Paseo++.exe",
};

describe("packaged Windows toast history", () => {
  it("is available on a packaged Windows build with an explicit app user model ID", () => {
    const history = createPackagedWindowsToastHistory(packagedWindows);

    expect(history).not.toBeNull();
  });

  it.each([
    ["an unpackaged Windows build", { isPackaged: false }],
    ["a build without an explicit app user model ID", { appUserModelId: null }],
    ["a non-Windows build", { platform: "darwin" as const }],
  ])("is absent on %s", (_label, override) => {
    expect(createPackagedWindowsToastHistory({ ...packagedWindows, ...override })).toBeNull();
  });
});

describe("Windows toast history process use", () => {
  /** A runner whose calls stay pending until the test settles them. */
  function deferredRunner() {
    const calls: Array<{
      request: WindowsToastHistoryOperation;
      resolve(stdout: string): void;
      reject(error: Error): void;
    }> = [];
    const run: WindowsToastHistoryRunner = (request) =>
      new Promise((resolve, reject) => calls.push({ request, resolve, reject }));
    return { calls, run };
  }

  const owner = { executable: "C:\\Paseo++.exe" };

  it("shares one in-flight list between concurrent readers", async () => {
    const runner = deferredRunner();
    const history = createWindowsToastHistory(owner, runner.run);

    const first = history.list();
    const second = history.list();
    expect(runner.calls).toHaveLength(1);

    runner.calls[0].resolve("[]");
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });

  it("starts a fresh list once the previous one settled", async () => {
    const runner = deferredRunner();
    const history = createWindowsToastHistory(owner, runner.run);

    const first = history.list();
    runner.calls[0].resolve("[]");
    await first;
    const second = history.list();

    expect(runner.calls).toHaveLength(2);
    runner.calls[1].resolve("[]");
    await second;
  });

  it("runs removals one at a time and continues after a failed removal", async () => {
    const runner = deferredRunner();
    const history = createWindowsToastHistory(owner, runner.run);

    const failed = history.removeCurrentLive("first");
    const next = history.removeCurrentLive("second");
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    expect(runner.calls[0].request).toEqual({ operation: "removeCurrentLive", tag: "first" });

    runner.calls[0].reject(new Error("history busy"));
    await expect(failed).rejects.toThrow("history busy");
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    expect(runner.calls[1].request).toEqual({ operation: "removeCurrentLive", tag: "second" });
    runner.calls[1].resolve("");
    await expect(next).resolves.toBeUndefined();
  });
});
