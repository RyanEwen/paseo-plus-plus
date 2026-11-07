import { describe, expect, it } from "vitest";
import { encodedVideoRuntimeHtml } from "./html.gen";

describe("Android video canvas document", () => {
  it("ships a closed network policy", () => {
    expect(encodedVideoRuntimeHtml).toContain("default-src 'none'");
    expect(encodedVideoRuntimeHtml).toContain("connect-src 'none'");
    expect(encodedVideoRuntimeHtml).toContain("media-src 'none'");
    expect(encodedVideoRuntimeHtml).toContain("frame-src 'none'");
    expect(encodedVideoRuntimeHtml).toContain("base-uri 'none'");
    expect(encodedVideoRuntimeHtml).toContain("form-action 'none'");
  });
});
