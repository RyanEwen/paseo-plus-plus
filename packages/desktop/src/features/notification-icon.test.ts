import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheNotificationIcon, readNotificationIconBytes } from "./notification-icon.js";

describe("Notification project icon boundary", () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1kAAAAASUVORK5CYII=";

  it("reuses content-addressed icon files and repairs corrupt entries without temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paseo-notification-icon-"));
    try {
      const bytes = Buffer.from(png, "base64");
      const iconPath = await cacheNotificationIcon({ directory, bytes });
      expect(await readFile(iconPath)).toEqual(bytes);
      expect(await cacheNotificationIcon({ directory, bytes })).toBe(iconPath);
      await writeFile(iconPath, "interrupted write");
      expect(await cacheNotificationIcon({ directory, bytes })).toBe(iconPath);
      expect(await readFile(iconPath)).toEqual(bytes);
      expect(await readdir(directory)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts small square PNG bytes and rejects paths, remote URLs and other image types", () => {
    expect(readNotificationIconBytes(`data:image/png;base64,${png}`)).toEqual(
      Buffer.from(png, "base64"),
    );
    for (const input of [
      "https://example.com/icon.png",
      "C:\\icon.png",
      `data:image/svg+xml;base64,${png}`,
      null,
      "data:image/png;base64,YWJj",
    ]) {
      expect(readNotificationIconBytes(input)).toBeNull();
    }
  });

  it("rejects oversized encoded input and pixel dimensions before image decoding", () => {
    expect(readNotificationIconBytes(`data:image/png;base64,${"A".repeat(128 * 1024)}`)).toBeNull();
    for (const [width, height] of [
      [129, 129],
      [0, 0],
      [64, 32],
      [0xffffffff, 0xffffffff],
    ]) {
      const bytes = Buffer.from(png, "base64");
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      expect(
        readNotificationIconBytes(`data:image/png;base64,${bytes.toString("base64")}`),
      ).toBeNull();
    }
  });
});
