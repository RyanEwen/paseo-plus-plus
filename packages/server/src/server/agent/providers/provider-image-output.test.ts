import { existsSync, readFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { projectTimelineRows } from "../timeline-projection.js";
import { describe, expect, test } from "vitest";
import { MAX_PROVIDER_IMAGE_BYTES, isProviderImageMarkdown, materializeProviderImage, renderProviderImageOutputAsAssistantMarkdown, PROVIDER_IMAGE_MAX_BYTES, PROVIDER_IMAGE_MAX_BASE64_LENGTH } from "./provider-image-output.js";

const HASH = "a".repeat(64);
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";

async function renderImageMarkdown(imagePath: string): Promise<string> {
  const item = await renderProviderImageOutputAsAssistantMarkdown({ path: imagePath });
  if (!item || item.type !== "assistant_message") {
    throw new Error("Expected provider image output to render as assistant markdown.");
  }
  return item.text;
}

describe("isProviderImageMarkdown", () => {
  test("matches the markdown emitted for a materialized attachment", () => {
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/${HASH}.png)`)).toBe(true);
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments-a1B2c3/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![Image](/tmp/paseo-attachments/user-1000/${HASH}.png)`)).toBe(
      true,
    );
    expect(isProviderImageMarkdown(`![shot](/var/folders/x/paseo-attachments/${HASH}.webp)`)).toBe(
      true,
    );
    // Windows: backslash path separators are doubled by escapeMarkdownImageSource.
    expect(
      isProviderImageMarkdown(
        `![Image](C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Temp\\\\paseo-attachments\\\\${HASH}.png)`,
      ),
    ).toBe(true);
  });

  test("emits Windows file paths as file URIs", async () => {
    const markdown = await renderImageMarkdown(
      `C:\\Users\\me\\AppData\\Local\\Temp\\paseo-attachments\\${HASH}.png`,
    );

    expect(markdown).toBe(
      `\n\n![Image](file:///C:/Users/me/AppData/Local/Temp/paseo-attachments/${HASH}.png)\n\n`,
    );
    expect(isProviderImageMarkdown(markdown)).toBe(true);
  });

  test("emits POSIX file paths with spaces as valid file URI markdown", async () => {
    const markdown = await renderImageMarkdown(
      "/home/user/Projects/Project With Spaces/screenshot.png",
    );

    expect(markdown).toBe(
      "\n\n![Image](file:///home/user/Projects/Project%20With%20Spaces/screenshot.png)\n\n",
    );
  });

  test("encodes URI-significant characters in POSIX file paths", async () => {
    const markdown = await renderImageMarkdown("/tmp/screenshot#1?draft.png");

    expect(markdown).toBe("\n\n![Image](file:///tmp/screenshot%231%3Fdraft.png)\n\n");
  });

  test("preserves double-leading slashes in POSIX file paths", async () => {
    const markdown = await renderImageMarkdown("//tmp/screenshot#1.png");

    expect(markdown).toBe("\n\n![Image](file:////tmp/screenshot%231.png)\n\n");
  });

  test.each([
    ["UNC", "\\\\server\\share\\shot#1.png", "file://server/share/shot%231.png"],
    [
      "extended UNC",
      "\\\\?\\UNC\\server\\share\\shot?draft.png",
      "file://server/share/shot%3Fdraft.png",
    ],
  ])("encodes %s image paths as file URIs", async (_label, imagePath, expectedSource) => {
    expect(await renderImageMarkdown(imagePath)).toBe(`\n\n![Image](${expectedSource})\n\n`);
  });

  test("rejects user-authored markdown that is not a materialized attachment", () => {
    // No content hash — a hand-written path, not something the writer produced.
    expect(isProviderImageMarkdown("![diagram](./paseo-attachments/notes.png)")).toBe(false);
    expect(isProviderImageMarkdown("![logo](https://example.com/logo.png)")).toBe(false);
    // Image markdown that does not start the text.
    expect(isProviderImageMarkdown("see the chart: ![chart](x.png)")).toBe(false);
  });
});

describe("materializeProviderImage", async () => {
  test.each([PNG, PNG.replace(/=+$/, ""), `data:image/png;base64,${PNG}`, `  ${PNG}\n`])(
    "preserves accepted original bytes and content identity",
    async (data) => {
      const result = await materializeProviderImage({ data, mimeType: "image/png" });
      const bytes = Buffer.from(PNG, "base64");
      expect(readFileSync(result.path)).toEqual(bytes);
      expect(path.basename(result.path)).toBe(
        `${createHash("sha256").update(bytes).digest("hex")}.png`,
      );
      expect((await materializeProviderImage({ data: PNG, mimeType: "image/png" })).path).toBe(
        result.path,
      );
    },
  );

  test.each([
    ["image/jpeg", [255, 216, 255]],
    ["image/gif", [...Buffer.from("GIF89a")]],
    ["image/webp", [...Buffer.from("RIFF0000WEBP")]],
    ["image/bmp", [66, 77]],
    ["image/tiff", [73, 73, 42, 0]],
    ["image/tiff", [77, 77, 0, 43]],
  ])("recognizes %s container signatures without changing bytes", async (mimeType, signature) => {
    const bytes = Buffer.from(signature);
    const result = await materializeProviderImage({ data: bytes.toString("base64"), mimeType });
    expect(readFileSync(result.path)).toEqual(bytes);
  });

  test("rejects oversized strings before normalization and never writes rejected inputs", async () => {
    const accepted = await materializeProviderImage({ data: PNG, mimeType: "image/png" });
    const directory = path.dirname(accepted.path);
    const before = readdirSync(directory);
    // Trimming first would hide this overflow and report malformed base64 instead.
    const oversized = " ".repeat(PROVIDER_IMAGE_MAX_BASE64_LENGTH + 257);
    for (const data of [oversized, `data:image/png;base64,${oversized}`]) {
      await expect(materializeProviderImage({ data, mimeType: "image/png" })).rejects.toThrow(
        "16 MiB",
      );
    }
    // Within the encoded-character ceiling, but greater than the decoded-byte ceiling.
    const decodedOverflow = "A".repeat(PROVIDER_IMAGE_MAX_BASE64_LENGTH);
    await expect(
      materializeProviderImage({ data: decodedOverflow, mimeType: "image/png" }),
    ).rejects.toThrow("16 MiB");
    expect(PROVIDER_IMAGE_MAX_BYTES % 3).toBe(1);
    expect(readdirSync(directory)).toEqual(before);
  });

  test.each([
    "",
    "a",
    "YWJj$",
    "YW Jj",
    "AAAA===",
    "AA=",
    "AB==",
    "data:image/png,AAAA",
    "data:text/plain;base64,AAAA",
  ])("rejects malformed input without a file", async (data) => {
    await expect(materializeProviderImage({ data, mimeType: "image/png" })).rejects.toThrow();
  });

  test("rejects unsupported formats and MIME/signature mismatches", async () => {
    await expect(
      materializeProviderImage({ data: PNG, mimeType: "image/svg+xml" }),
    ).rejects.toThrow("unsupported");
    await expect(materializeProviderImage({ data: PNG, mimeType: "image/jpeg" })).rejects.toThrow(
      "declared format",
    );
  });

  test("renders explicit rejection without forwarding oversized data to a materializer", async () => {
    let calls = 0;
    const item = await renderProviderImageOutputAsAssistantMarkdown(
      { data: "A".repeat(PROVIDER_IMAGE_MAX_BASE64_LENGTH + 257) },
      {
        materialize() {
          calls++;
          throw new Error("must not be reached");
        },
      },
    );
    expect(calls).toBe(0);
    expect(item).toEqual({
      type: "assistant_message",
      text: "Image output omitted: Image input exceeds the 16 MiB attachment limit.",
    });
    expect(
      await renderProviderImageOutputAsAssistantMarkdown(
        { data: "bad", mimeType: "image/png" },
        { materialize: materializeProviderImage },
      ),
    ).toMatchObject({
      type: "assistant_message",
      text: expect.stringContaining("Image output omitted:"),
    });
  });

  test("recreates the private temp directory if the cached directory is removed", async () => {
    const first = await materializeProviderImage({
      data: PNG,
      mimeType: "image/png",
    });
    const firstDir = path.dirname(first.path);
    expect(existsSync(first.path)).toBe(true);

    rmSync(firstDir, { recursive: true, force: true });

    const second = await materializeProviderImage({
      data: PNG,
      mimeType: "image/png",
    });
    const secondDir = path.dirname(second.path);

    try {
      expect(existsSync(second.path)).toBe(true);
    } finally {
      rmSync(secondDir, { recursive: true, force: true });
    }
  });
});


describe("provider image paragraph boundaries", () => {
  test.each(["", "\n"])("keeps image outputs separate from prose ending in %j", async (ending) => {
    const image = await renderProviderImageOutputAsAssistantMarkdown({
      url: "https://example.com/chart.png",
    });
    if (!image) throw new Error("Expected image output");
    const projected = projectTimelineRows({
      mode: "projected",
      rows: [
        {
          seq: 1,
          timestamp: "2026-10-16T15:08:23Z",
          item: { type: "assistant_message", text: `Before${ending}`, messageId: "commentary" },
        },
        { seq: 2, timestamp: "2026-10-16T15:08:24Z", item: image },
        {
          seq: 3,
          timestamp: "2026-10-16T15:08:25Z",
          item: { type: "assistant_message", text: "After" },
        },
      ],
    });
    expect(projected).toHaveLength(1);
    const item = projected[0]!.item;
    if (item.type !== "assistant_message") throw new Error("Expected assistant message");
    const paragraphs = new MarkdownIt()
      .parse(item.text, {})
      .filter((token) => token.type === "inline");
    expect(paragraphs.map((token) => token.content)).toEqual([
      "Before",
      "![Image](https://example.com/chart.png)",
      "After",
    ]);
  });
});

test("materialized image output retains paragraph boundaries and attachment recognition", async () => {
  const item = await renderProviderImageOutputAsAssistantMarkdown(
    { data: "YWJjMTIz", mimeType: "image/png" },
    { materialize: async () => ({ path: `/tmp/paseo-attachments/${HASH}.png` }) },
  );
  expect(item).toEqual({
    type: "assistant_message",
    text: `\n\n![Image](file:///tmp/paseo-attachments/${HASH}.png)\n\n`,
  });
  if (!item || item.type !== "assistant_message") throw new Error("Expected image output");
  expect(isProviderImageMarkdown(item.text)).toBe(true);
});

test("repeated content is reused without rewriting the attachment", async () => {
  const image = {
    data: PNG,
    mimeType: "image/png",
  };
  const first = await materializeProviderImage(image);
  const before = statSync(first.path, { bigint: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await materializeProviderImage(image);
  expect(second.path).toBe(first.path);
  expect(statSync(second.path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
});

test("8 MiB materialization leaves the event loop responsive and preserves bytes", async () => {
  const bytes = Buffer.concat([
    Buffer.from(PNG, "base64").subarray(0, 8),
    Buffer.alloc(8 * 1024 * 1024 - 8, 37),
  ]);
  const data = bytes.toString("base64");
  // Main-thread CPU time between ticks bounds the decode and hash work done on the loop;
  // wall-clock gaps on shared CI runners also count preemption and timer granularity.
  // File writes stay on fs/promises, so they never block the loop.
  const threadCpuMs = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
  };
  let previous = threadCpuMs();
  let longest = 0;
  const probe = setInterval(() => {
    const now = threadCpuMs();
    longest = Math.max(longest, now - previous);
    previous = now;
  }, 1);
  try {
    const result = await materializeProviderImage({ data, mimeType: "image/png" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    console.log(`8 MiB attachment longest blocking stretch: ${longest.toFixed(2)} ms CPU`);
    expect(longest).toBeLessThan(50);
    expect(readFileSync(result.path).equals(bytes)).toBe(true);
    rmSync(result.path, { force: true });
  } finally {
    clearInterval(probe);
  }
});

test("preserves strict base64 decoding across chunk boundaries", async () => {
  const bytes = Buffer.concat([
    Buffer.from(PNG, "base64").subarray(0, 8),
    Buffer.alloc(512 * 1024 - 8, 123),
  ]);
  const base64 = bytes.toString("base64");
  const data = base64;
  const result = await materializeProviderImage({ data, mimeType: "image/png" });
  expect(readFileSync(result.path).equals(bytes)).toBe(true);
});

test("rejects oversized materialization before work and leaves the queue usable", async () => {
  const data = "A".repeat(Math.ceil(MAX_PROVIDER_IMAGE_BYTES / 3) * 4 + 260);
  await expect(materializeProviderImage({ data, mimeType: "image/png" })).rejects.toThrow(
    "exceeds",
  );
  const omitted = await renderProviderImageOutputAsAssistantMarkdown(
    { data, mimeType: "image/png" },
    { materialize: materializeProviderImage },
  );
  expect(omitted).toEqual({
    type: "assistant_message",
    text: "Image output omitted: Image input exceeds the 16 MiB attachment limit.",
  });
  const image = await materializeProviderImage({ data: PNG, mimeType: "image/png" });
  expect(readFileSync(image.path)).toEqual(Buffer.from(PNG, "base64"));
});

test("simultaneous requests for the same content share the published file", async () => {
  const image = {
    data: PNG,
    mimeType: "image/png",
  };
  const results = await Promise.all([
    materializeProviderImage(image),
    materializeProviderImage(image),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(readFileSync(results[0].path)).toEqual(Buffer.from(PNG, "base64"));
});
