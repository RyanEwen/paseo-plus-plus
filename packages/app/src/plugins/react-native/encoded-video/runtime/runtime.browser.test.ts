import { afterEach, describe, expect, it, vi } from "vitest";
import type { EncodedVideoChunk, EncodedVideoConfig } from "@getpaseo/plugin/client/ui";
import { encodedVideoRuntimeHtml } from "./html.gen";
import {
  parseCanvasToHostMessage,
  type CanvasToHostMessage,
  type HostToCanvasMessage,
} from "./messages";

/**
 * Exercises the generated canvas document with real WebCodecs in Vitest browser mode.
 * Only VP8 runs here: the bundled Chromium has no proprietary H.264 decoder, so H.264
 * is covered by the Android device check in docs/fork-features/android-plugin-video.md.
 */

interface MountedCanvas {
  frame: HTMLIFrameElement;
  messages: CanvasToHostMessage[];
}

const mounted: { frame: HTMLIFrameElement; listener: (event: MessageEvent) => void }[] = [];

afterEach(() => {
  for (const { frame, listener } of mounted.splice(0)) {
    window.removeEventListener("message", listener);
    frame.remove();
  }
});

/** Mount the document in a same-origin frame so the test can drive it and read its canvas. */
async function mountCanvas(): Promise<MountedCanvas> {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts", "allow-same-origin");
  const messages: CanvasToHostMessage[] = [];
  const listener = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow) {
      return;
    }
    const message = parseCanvasToHostMessage(JSON.stringify(event.data));
    if (message) {
      messages.push(message);
    }
  };
  window.addEventListener("message", listener);
  mounted.push({ frame, listener });
  frame.srcdoc = encodedVideoRuntimeHtml;
  document.body.append(frame);
  await waitForMessage({ messages }, (message) => message.type === "ready");
  return { frame, messages };
}

function canvasWindow(canvas: MountedCanvas): Window {
  const view = canvas.frame.contentWindow;
  if (!view) {
    throw new Error("Canvas frame is not attached");
  }
  return view;
}

function send(canvas: MountedCanvas, message: HostToCanvasMessage): void {
  const receive = canvasWindow(canvas).__PASEO_VIDEO__;
  if (!receive) {
    throw new Error("Canvas runtime is not installed");
  }
  receive(message);
}

/** Wait for codec and paint events without wall-clock delays. */
async function waitForMessage(
  canvas: Pick<MountedCanvas, "messages">,
  predicate: (message: CanvasToHostMessage) => boolean,
): Promise<CanvasToHostMessage> {
  return vi.waitFor(
    () => {
      const message = canvas.messages.find(predicate);
      if (!message) {
        throw new Error("Canvas message has not arrived");
      }
      return message;
    },
    { timeout: 10_000 },
  );
}

/** The document posts to this page asynchronously, so a failure lands after send() returns. */
function waitForError(canvas: MountedCanvas, text: string): Promise<CanvasToHostMessage> {
  return waitForMessage(canvas, (message) => message.type === "error" && message.message === text);
}

async function waitForFrame(canvas: MountedCanvas, timestamp: number) {
  const message = await waitForMessage(
    canvas,
    (candidate) => candidate.type === "frame" && candidate.frame.timestamp === timestamp,
  );
  if (message.type !== "frame") {
    throw new Error(`Expected a frame, got ${message.type}`);
  }
  return message.frame;
}

function messagesOfType(canvas: MountedCanvas, type: CanvasToHostMessage["type"]) {
  return canvas.messages.filter((message) => message.type === type);
}

async function nextPaint(canvas: MountedCanvas): Promise<void> {
  await new Promise((resolve) => canvasWindow(canvas).requestAnimationFrame(resolve));
}

function centrePixel(canvas: MountedCanvas): number[] {
  const element = canvas.frame.contentDocument?.querySelector("canvas");
  const context = element?.getContext("2d");
  if (!context) {
    throw new Error("Canvas has no 2D context");
  }
  return Array.from(context.getImageData(8, 8, 1, 1).data);
}

/** Encode solid 16x16 frames (red, then lime) into raw VP8 key/delta chunks. */
async function encodedFrames(count = 1) {
  const source = document.createElement("canvas");
  source.width = 16;
  source.height = 16;
  const context = source.getContext("2d");
  if (!context) {
    throw new Error("Source canvas has no 2D context");
  }
  const chunks: EncodedVideoChunk[] = [];
  let config: EncodedVideoConfig | undefined;
  let failure: DOMException | null = null;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      const decoderConfig = metadata?.decoderConfig;
      if (decoderConfig?.codedWidth && decoderConfig.codedHeight) {
        config = {
          codec: decoderConfig.codec,
          codedWidth: decoderConfig.codedWidth,
          codedHeight: decoderConfig.codedHeight,
          colorSpace: decoderConfig.colorSpace,
          optimizeForLatency: true,
        };
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      let binary = "";
      for (const byte of data) {
        binary += String.fromCharCode(byte);
      }
      chunks.push({ type: chunk.type, timestamp: chunk.timestamp, dataBase64: btoa(binary) });
    },
    error(error) {
      failure = error;
    },
  });
  try {
    encoder.configure({
      codec: "vp8",
      width: 16,
      height: 16,
      bitrate: 100_000,
      latencyMode: "realtime",
    });
    for (let index = 0; index < count; index += 1) {
      context.fillStyle = index === 0 ? "red" : "lime";
      context.fillRect(0, 0, 16, 16);
      const frame = new VideoFrame(source, { timestamp: (index + 1) * 1000 });
      encoder.encode(frame, { keyFrame: index === 0 });
      frame.close();
    }
    await encoder.flush();
    if (failure) {
      throw failure;
    }
    if (!config) {
      throw new Error("VideoEncoder did not supply decoder configuration");
    }
    return { chunks, config };
  } finally {
    if (encoder.state !== "closed") {
      encoder.close();
    }
  }
}

async function keyframe() {
  const { chunks, config } = await encodedFrames();
  const [first] = chunks;
  if (!first) {
    throw new Error("VideoEncoder produced no chunks");
  }
  return { dataBase64: first.dataBase64, config };
}

/** Configure generation 1 and decode one red keyframe at 1000. */
async function decodeKeyframe(canvas: MountedCanvas) {
  const { dataBase64, config } = await keyframe();
  send(canvas, { type: "configure", generation: 1, config });
  send(canvas, {
    type: "decode",
    generation: 1,
    chunk: { type: "key", timestamp: 1000, dataBase64 },
  });
  return waitForFrame(canvas, 1000);
}

describe("Android video canvas document", () => {
  it("decodes VP8 and acknowledges only an explicitly painted frame", async () => {
    const canvas = await mountCanvas();
    const frame = await decodeKeyframe(canvas);
    expect(frame).toEqual({ id: 1, timestamp: 1000, displayWidth: 16, displayHeight: 16 });
    expect(messagesOfType(canvas, "presented")).toEqual([]);

    send(canvas, { type: "present", generation: 1, frameId: frame.id, requestId: 3 });
    const presented = await waitForMessage(canvas, (message) => message.type === "presented");
    expect(presented).toEqual({ type: "presented", generation: 1, requestId: 3 });

    const [red, green, blue, alpha] = centrePixel(canvas);
    expect(red).toBeGreaterThan(240);
    expect(green).toBeLessThan(10);
    expect(blue).toBeLessThan(10);
    expect(alpha).toBe(255);
    expect(messagesOfType(canvas, "dequeue")).toHaveLength(1);
  });

  it("presents a continuous VP8 key/delta chain", async () => {
    const canvas = await mountCanvas();
    const { chunks, config } = await encodedFrames(3);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["key", "delta", "delta"]);
    send(canvas, { type: "configure", generation: 1, config });
    for (const chunk of chunks) {
      send(canvas, { type: "decode", generation: 1, chunk });
      await waitForFrame(canvas, chunk.timestamp);
    }
    const last = await waitForFrame(canvas, 3000);

    send(canvas, { type: "present", generation: 1, frameId: last.id, requestId: 1 });
    await waitForMessage(canvas, (message) => message.type === "presented");

    const [red, green, blue] = centrePixel(canvas);
    expect(red).toBeLessThan(10);
    expect(green).toBeGreaterThan(240);
    expect(blue).toBeLessThan(10);
    expect(messagesOfType(canvas, "error")).toEqual([]);
  });

  it("reset releases retained frames and cannot acknowledge obsolete paint", async () => {
    const canvas = await mountCanvas();
    await decodeKeyframe(canvas);

    send(canvas, { type: "present", generation: 1, frameId: 1, requestId: 1 });
    send(canvas, { type: "reset", generation: 2 });
    await nextPaint(canvas);
    await nextPaint(canvas);
    expect(messagesOfType(canvas, "presented")).toEqual([]);

    send(canvas, { type: "present", generation: 2, frameId: 1, requestId: 2 });
    await waitForError(canvas, "Video frame was released");
  });

  it("settles presentation failure when its retained frame is released before paint", async () => {
    const canvas = await mountCanvas();
    await decodeKeyframe(canvas);

    send(canvas, { type: "present", generation: 1, frameId: 1, requestId: 1 });
    send(canvas, { type: "release", generation: 1, frameId: 1 });
    await nextPaint(canvas);
    await nextPaint(canvas);

    expect(messagesOfType(canvas, "presented")).toEqual([]);
    const failure = await waitForError(canvas, "Video frame was released before presentation");
    expect(failure).toMatchObject({ generation: 1 });
  });

  it("decodes and presents a supported codec after configuration fails", async () => {
    const canvas = await mountCanvas();
    send(canvas, {
      type: "configure",
      generation: 1,
      config: { codec: "invalid-codec", codedWidth: 16, codedHeight: 16, optimizeForLatency: true },
    });
    await waitForMessage(canvas, (message) => message.type === "error");
    expect(canvas.messages.at(-1)).toMatchObject({ type: "error", generation: 1 });

    const { dataBase64, config } = await keyframe();
    send(canvas, { type: "configure", generation: 3, config });
    send(canvas, {
      type: "decode",
      generation: 3,
      chunk: { type: "key", timestamp: 1000, dataBase64 },
    });
    const frame = await waitForFrame(canvas, 1000);
    send(canvas, { type: "present", generation: 3, frameId: frame.id, requestId: 1 });
    await waitForMessage(canvas, (message) => message.type === "presented");
    expect(canvas.messages.at(-1)).toMatchObject({
      type: "presented",
      generation: 3,
      requestId: 1,
    });
  });

  it("reports decoding without a configured decoder separately from queue overflow", async () => {
    const canvas = await mountCanvas();
    const { dataBase64 } = await keyframe();
    send(canvas, {
      type: "decode",
      generation: 1,
      chunk: { type: "key", timestamp: 1000, dataBase64 },
    });
    await waitForError(canvas, "Video decoder is not configured");
  });

  it("blocks network requests from the private decoder document", async () => {
    const canvas = await mountCanvas();
    // The test server's own page is reachable from the test, so only the document's
    // connect-src policy can make the same request fail inside the frame.
    const reachable = new URL("/", window.location.href).href;
    await expect(fetch(reachable)).resolves.toBeDefined();
    await expect(canvasWindow(canvas).fetch(reachable)).rejects.toThrow();
  });
});
