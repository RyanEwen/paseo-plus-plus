import { describe, expect, it } from "vitest";
import type { EncodedVideoConfig, EncodedVideoFrame } from "@getpaseo/plugin/client/ui";
import { createEncodedVideoBridge, type EncodedVideoCallbacks } from "./bridge";

/** Records what the bridge injects and what it reports to the plugin. */
function createHarness() {
  const scripts: string[] = [];
  const events = {
    ready: 0,
    frames: [] as EncodedVideoFrame[],
    dequeued: 0,
    errors: [] as string[],
  };
  const callbacks: EncodedVideoCallbacks = {
    onReady: () => {
      events.ready += 1;
    },
    onFrame: (frame) => {
      events.frames.push(frame);
    },
    onDequeue: () => {
      events.dequeued += 1;
    },
    onError: (error) => {
      events.errors.push(error.message);
    },
  };
  const bridge = createEncodedVideoBridge({
    transport: () => ({ injectJavaScript: (script) => scripts.push(script) }),
    callbacks: () => callbacks,
  });
  const receive = (message: object) => bridge.receive(JSON.stringify(message));
  receive({ type: "ready" });
  return { bridge, handle: bridge.handle, scripts, events, receive };
}

const config: EncodedVideoConfig = {
  codec: "vp8",
  codedWidth: 16,
  codedHeight: 16,
  optimizeForLatency: true,
};

describe("createEncodedVideoBridge", () => {
  it("reconfigures after an error while rejecting failed and stale paints", async () => {
    const { handle, scripts, events, receive } = createHarness();
    handle.configure(config);
    const failedPaint = expect(handle.present(1)).rejects.toThrow("Unsupported codec");
    receive({ type: "error", generation: 1, message: "Unsupported codec" });
    await failedPaint;
    expect(events.errors).toEqual(["Unsupported codec"]);

    handle.configure(config);
    expect(scripts.at(-1)).toBe(
      'window.__PASEO_VIDEO__({"type":"configure","config":{"codec":"vp8","codedWidth":16,"codedHeight":16,"optimizeForLatency":true},"generation":3});true;',
    );
    const frame = { id: 2, timestamp: 2000, displayWidth: 16, displayHeight: 16 };
    receive({ type: "frame", generation: 1, frame });
    expect(events.frames).toEqual([]);
    receive({ type: "frame", generation: 3, frame });
    expect(events.frames).toEqual([frame]);

    const recoveredPaint = handle.present(frame.id);
    receive({ type: "presented", generation: 3, requestId: 2 });
    await expect(recoveredPaint).resolves.toBeUndefined();
    expect(events.ready).toBe(1);
  });

  it("keeps a stopped document unavailable until it reports ready again", async () => {
    const { bridge, handle, receive } = createHarness();
    handle.configure(config);
    const failedPaint = expect(handle.present(1)).rejects.toThrow("Video decoder process stopped");
    bridge.documentFailed(new Error("Video decoder process stopped"));
    await failedPaint;
    expect(() => handle.configure(config)).toThrow("Video decoder is not ready");
    expect(() => handle.reset()).not.toThrow();

    receive({ type: "ready" });
    expect(() => handle.configure(config)).not.toThrow();
  });

  it("treats an unparseable canvas message as a document failure", () => {
    const { bridge, handle, events } = createHarness();
    bridge.receive("not json");
    expect(events.errors).toEqual(["Invalid video decoder message"]);
    expect(() => handle.configure(config)).toThrow("Video decoder is not ready");
  });

  it("rejects pending paints and ignores later output after dispose", async () => {
    const { bridge, handle, events, receive } = createHarness();
    handle.configure(config);
    const paint = expect(handle.present(1)).rejects.toThrow("Video surface unmounted");
    bridge.dispose();
    await paint;
    receive({ type: "dequeue", generation: 1 });
    expect(events.dequeued).toBe(0);
  });
});
