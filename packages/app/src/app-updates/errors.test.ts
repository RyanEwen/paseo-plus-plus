import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import { describeUpdateFailure } from "./errors";

const FALLBACK = "Unable to install update";

function nativeRejection(code: string): Error {
  return Object.assign(new Error("Call to function has been rejected."), { code });
}

describe("Android update failure copy", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it.each([
    ["ERR_UPDATE_SAVE_FAILED", "Unable to save the downloaded update."],
    ["ERR_UPDATE_UNEXPECTED_URL", "Unexpected fork release asset URL"],
    ["ERR_UPDATE_INVALID_CHECKSUM", "Invalid update checksum."],
    ["ERR_UPDATE_CHECKSUM_MISMATCH", "Update checksum mismatch. Try downloading again."],
    ["ERR_UPDATE_PREVIEW_BUILDS_ONLY", "App updates are available only in fork preview builds."],
    ["ERR_UPDATE_INVALID_APK", "The downloaded APK is invalid. Download it again."],
    ["ERR_UPDATE_OTHER_APP", "The update belongs to another app."],
    ["ERR_UPDATE_VERSION_MISMATCH", "The update version does not match or is no longer newer."],
    ["ERR_UPDATE_SIGNING_MISMATCH", "The update signing key does not match this installation."],
    ["ERR_UPDATE_INSECURE_REDIRECT", "Insecure update download redirect."],
    ["ERR_UPDATE_INVALID_REDIRECT", "Invalid download redirect."],
    ["ERR_UPDATE_TIMED_OUT", "Update download timed out. Try again."],
    ["ERR_UPDATE_TOO_LARGE", "Update APK exceeds the download limit."],
    ["ERR_UPDATE_TOO_MANY_REDIRECTS", "Too many update download redirects."],
    ["ERR_UPDATE_DOWNLOAD_HTTP_404", "Update download failed (HTTP 404)."],
  ])("translates %s", (code, text) => {
    expect(describeUpdateFailure(nativeRejection(code), FALLBACK)).toBe(text);
  });

  it("follows the active language", async () => {
    await i18n.changeLanguage("fr");
    const translated = describeUpdateFailure(nativeRejection("ERR_UPDATE_TIMED_OUT"), FALLBACK);
    await i18n.changeLanguage("en");
    expect(translated).toBe("Le téléchargement a expiré. Réessayez.");
  });

  it("keeps other errors' own text and falls back for non-errors", () => {
    expect(describeUpdateFailure(nativeRejection("ERR_OTHER"), FALLBACK)).toBe(
      "Call to function has been rejected.",
    );
    expect(describeUpdateFailure(new Error("Offline"), FALLBACK)).toBe("Offline");
    expect(describeUpdateFailure("nope", FALLBACK)).toBe(FALLBACK);
  });
});
