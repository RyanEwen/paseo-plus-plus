import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
const { configureAndroidReleaseSigning } = require("./with-android-release-signing");

describe("Android release signing plugin", () => {
  it("replaces development signing only in the installed Expo template's release build", () => {
    const template = path.join(path.dirname(require.resolve("expo/package.json")), "template.tgz");
    const gradle = execFileSync("tar", ["-xOf", template, "package/android/app/build.gradle"], {
      encoding: "utf8",
    });
    const configured = configureAndroidReleaseSigning(gradle);
    expect(configured).toMatch(/debug\s*\{\s*signingConfig signingConfigs.debug/);
    expect(configured).toMatch(/release\s*\{[^{}]*signingConfig signingConfigs.preview/);
    expect(configured).toContain('storePassword System.getenv("PASEO_ANDROID_KEYSTORE_PASSWORD")');
    expect(() => configureAndroidReleaseSigning("android {}")).toThrow("signing layout changed");
  });
});
