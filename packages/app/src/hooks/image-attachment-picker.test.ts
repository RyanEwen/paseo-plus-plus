import { describe, expect, it } from "vitest";
import type { DesktopDialogBridge, DesktopDialogOpenOptions } from "@/desktop/host";
import { normalizePickedImageAssets, pickImagesWithDesktopDialog } from "./image-attachment-picker";
import { getImageAttachmentPickerFailure } from "./image-attachment-picker-error";

function fakeDialogReturning(selection: string | string[] | null): {
  dialog: DesktopDialogBridge;
  recordedOptions: DesktopDialogOpenOptions[];
} {
  const recordedOptions: DesktopDialogOpenOptions[] = [];
  return {
    dialog: {
      open: async (options?: DesktopDialogOpenOptions) => {
        if (options) {
          recordedOptions.push(options);
        }
        return selection;
      },
    },
    recordedOptions,
  };
}

describe("image-attachment-picker", () => {
  it("reports only the failed stage and bounded Expo code without reading private error details", () => {
    const error = Object.assign(new Error("Failed to read file:///private/photos/family.png"), {
      code: "ERR_UNEXPECTED",
      uri: "content://private/photos/family.png",
      assets: [{ uri: "file:///private/photos/family.png" }],
    });
    Object.defineProperty(error, "cause", {
      get() {
        throw new Error("Private error details must not be inspected");
      },
    });

    expect(getImageAttachmentPickerFailure("library-launch", error)).toEqual({
      stage: "library-launch",
      code: "ERR_UNEXPECTED",
    });
    expect(error.code).toBe("ERR_UNEXPECTED");
    expect(error.message).toBe("Failed to read file:///private/photos/family.png");

    for (const code of ["ERR_file:///private/photos/family.png", "ERR_" + "A".repeat(81), 42]) {
      expect(getImageAttachmentPickerFailure("pending-result", { code })).toEqual({
        stage: "pending-result",
        code: "unknown",
      });
    }

    expect(
      getImageAttachmentPickerFailure("permission", "file:///private/photos/family.png"),
    ).toEqual({ stage: "permission", code: "unknown" });
    expect(
      getImageAttachmentPickerFailure(
        "pending-normalization",
        Object.defineProperty({}, "code", {
          get() {
            throw new Error("Private accessor must not be called");
          },
        }),
      ),
    ).toEqual({ stage: "pending-normalization", code: "unknown" });
  });

  it("normalizes a picked File into a blob source", async () => {
    const file = new File(["hello"], "picked.png", { type: "image/png" });

    const result = await normalizePickedImageAssets([
      {
        uri: "blob:test",
        mimeType: "image/png",
        fileName: null,
        file,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.source.kind).toBe("blob");
    expect(result[0]?.fileName).toBe("picked.png");
    expect(result[0]?.mimeType).toBe("image/png");
  });

  it("derives the type of a type-less picked File from its name", async () => {
    const file = new File(["image"], "picked.png");

    const result = await normalizePickedImageAssets([
      {
        uri: "blob:test",
        mimeType: null,
        fileName: null,
        file,
      },
    ]);

    expect(result).toEqual([
      {
        source: { kind: "blob", blob: file },
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);
  });

  it("keeps filesystem picker results as file uris", async () => {
    const result = await normalizePickedImageAssets([
      {
        uri: "file:///tmp/picked.png",
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///tmp/picked.png" },
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);
  });

  it("converts data urls into blob sources when no file path exists", async () => {
    const result = await normalizePickedImageAssets([
      {
        uri: "data:image/png;base64,AAEC",
        mimeType: "image/png",
        fileName: "inline.png",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.source.kind).toBe("blob");
    expect(result[0]?.fileName).toBe("inline.png");
    expect(result[0]?.mimeType).toBe("image/png");
  });

  it("uses the desktop dialog api when available", async () => {
    const { dialog, recordedOptions } = fakeDialogReturning(["/tmp/one.png", "/tmp/two.jpg"]);

    const result = await pickImagesWithDesktopDialog(dialog);

    expect(recordedOptions).toHaveLength(1);
    expect(recordedOptions[0]).toMatchObject({
      multiple: true,
      directory: false,
      title: "Attach images",
    });
    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "/tmp/one.png" },
        mimeType: "image/png",
        fileName: "one.png",
      },
      {
        source: { kind: "file_uri", uri: "/tmp/two.jpg" },
        mimeType: "image/jpeg",
        fileName: "two.jpg",
      },
    ]);
  });

  it("throws when desktop dialog API is not available", async () => {
    await expect(pickImagesWithDesktopDialog(null)).rejects.toThrow(
      "Desktop dialog API is not available.",
    );
    await expect(pickImagesWithDesktopDialog({})).rejects.toThrow(
      "Desktop dialog API is not available.",
    );
  });
});
