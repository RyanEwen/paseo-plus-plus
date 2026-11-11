import type { CanvasToHostMessage, HostToCanvasMessage } from "./messages";

/**
 * Private canvas document for Android plugin video. build-runtime.mjs bundles this file
 * into html.gen.ts, which the host loads into a closed-network WebView. Only type imports
 * are allowed here so the bundle stays free of app code.
 */

declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage?: (data: string) => void;
    };
    __PASEO_VIDEO__?: (message: HostToCanvasMessage) => void;
  }
}

/** Decoded frames the plugin has neither presented nor released; caps memory if a plugin leaks frames. */
const MAX_RETAINED_FRAMES = 64;

/** Chunks submitted but not yet dequeued by the decoder; bounds latency and bridge backlog. */
const MAX_QUEUED_CHUNKS = 4;

/** Base64 length of a 2 MiB packet (ceil(2 MiB / 3) * 4); larger payloads are refused. */
const MAX_PACKET_BASE64_LENGTH = 2_796_204;

/** Post to the React Native bridge, and to the parent frame when a test mounts the document. */
function sendToHost(message: CanvasToHostMessage): void {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));
  if (window.parent !== window) {
    window.parent.postMessage(message, "*");
  }
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns one WebCodecs decoder and the frames it has produced.
 *
 * `generation` is the canvas's own fence: it advances on every teardown so decoder
 * callbacks and scheduled paints from an older decoder do nothing. `hostGeneration` is
 * the host's fence, echoed on outbound messages so the host can do the same.
 */
class EncodedVideoCanvas {
  private decoder: VideoDecoder | null = null;
  private generation = 0;
  private hostGeneration = 0;
  private nextFrame = 0;
  private lastTimestamp = -1;
  private readonly frames = new Map<number, VideoFrame>();
  private readonly queued: number[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
  ) {}

  /** Apply one host message. Any thrown failure tears the decoder down and reports it. */
  receive(message: HostToCanvasMessage): void {
    try {
      this.dispatch(message);
    } catch (error) {
      this.fail(error);
    }
  }

  /** Close the decoder and every retained frame; later output from them is ignored. */
  teardown(): void {
    this.generation += 1;
    if (this.decoder && this.decoder.state !== "closed") {
      this.decoder.close();
    }
    this.decoder = null;
    for (const frame of this.frames.values()) {
      frame.close();
    }
    this.frames.clear();
    this.queued.length = 0;
    this.lastTimestamp = -1;
  }

  fail(error: unknown): void {
    this.teardown();
    sendToHost({ type: "error", generation: this.hostGeneration, message: errorMessage(error) });
  }

  private dispatch(message: HostToCanvasMessage): void {
    switch (message.type) {
      case "configure":
        this.configure(message);
        return;
      case "reset":
        this.hostGeneration = message.generation;
        this.teardown();
        return;
      case "decode":
        this.decode(message);
        return;
      case "release":
        this.release(message.frameId);
        return;
      case "present":
        this.present(message);
        return;
    }
  }

  /** Replace the decoder. Output and errors are bound to this decoder's generation. */
  private configure(message: Extract<HostToCanvasMessage, { type: "configure" }>): void {
    this.teardown();
    const current = this.generation;
    this.hostGeneration = message.generation;
    const decoder = new VideoDecoder({
      output: (frame) => this.retainFrame(frame, current),
      error: (error) => {
        if (this.generation === current) {
          this.fail(error);
        }
      },
    });
    decoder.addEventListener("dequeue", () =>
      this.acknowledgeDequeued(current, message.generation),
    );
    this.decoder = decoder;

    const { descriptionBase64, ...settings } = message.config;
    decoder.configure({
      ...settings,
      ...(descriptionBase64 ? { description: base64Bytes(descriptionBase64) } : {}),
    });
  }

  private retainFrame(frame: VideoFrame, decoderGeneration: number): void {
    if (this.generation !== decoderGeneration) {
      frame.close();
      return;
    }
    if (this.frames.size >= MAX_RETAINED_FRAMES) {
      frame.close();
      this.fail(new Error("Video frame buffer exceeded"));
      return;
    }
    const id = ++this.nextFrame;
    this.frames.set(id, frame);
    sendToHost({
      type: "frame",
      generation: this.hostGeneration,
      frame: {
        id,
        timestamp: frame.timestamp,
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
      },
    });
  }

  /** Send one acknowledgement per chunk the decoder has taken off its queue. */
  private acknowledgeDequeued(decoderGeneration: number, hostGeneration: number): void {
    if (this.generation !== decoderGeneration || !this.decoder) {
      return;
    }
    const completed = this.queued.length - this.decoder.decodeQueueSize;
    for (let index = 0; index < completed; index += 1) {
      this.queued.shift();
      sendToHost({ type: "dequeue", generation: hostGeneration });
    }
  }

  private decode(message: Extract<HostToCanvasMessage, { type: "decode" }>): void {
    if (!this.decoder) {
      throw new Error("Video decoder is not configured");
    }
    if (this.queued.length >= MAX_QUEUED_CHUNKS) {
      throw new Error("Video decode queue exceeded");
    }
    const { chunk } = message;
    if (chunk.dataBase64.length > MAX_PACKET_BASE64_LENGTH) {
      throw new Error("Video packet exceeded 2 MiB");
    }
    this.queued.push(chunk.timestamp);
    this.decoder.decode(
      new EncodedVideoChunk({
        type: chunk.type,
        timestamp: chunk.timestamp,
        data: base64Bytes(chunk.dataBase64),
      }),
    );
  }

  private release(frameId: number): void {
    this.frames.get(frameId)?.close();
    this.frames.delete(frameId);
  }

  /** Draw a retained frame on the next animation frame, then acknowledge the paint. */
  private present(message: Extract<HostToCanvasMessage, { type: "present" }>): void {
    const frame = this.frames.get(message.frameId);
    if (!frame) {
      throw new Error("Video frame was released");
    }
    const current = this.generation;
    requestAnimationFrame(() => {
      if (this.generation !== current) {
        return;
      }
      try {
        this.paint(message.frameId, frame);
        sendToHost({
          type: "presented",
          generation: message.generation,
          requestId: message.requestId,
        });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  /** Presenting a frame no newer than the last painted one is a plugin ordering error. */
  private paint(frameId: number, frame: VideoFrame): void {
    if (!this.frames.has(frameId)) {
      throw new Error("Video frame was released before presentation");
    }
    if (frame.timestamp <= this.lastTimestamp) {
      throw new Error("Obsolete video presentation");
    }
    // Assigning a canvas dimension reallocates and clears its backing store, even when
    // unchanged; a stream keeps one size, so only resize when the frame size changes.
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.context.drawImage(frame, 0, 0);
    this.lastTimestamp = frame.timestamp;
  }
}

/** Install the host entry point, then report readiness or the missing WebCodecs support. */
function start(): void {
  const canvas = document.querySelector("canvas");
  if (!canvas) {
    throw new Error("Video canvas is missing");
  }
  const context = canvas.getContext("2d");
  const runtime = context ? new EncodedVideoCanvas(canvas, context) : null;
  window.__PASEO_VIDEO__ = (message) => runtime?.receive(message);
  window.addEventListener("pagehide", () => runtime?.teardown());

  const supported = typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";
  if (!runtime || !supported) {
    sendToHost({
      type: "error",
      generation: 0,
      message: "Video streaming requires an updated Android System WebView",
    });
    return;
  }
  sendToHost({ type: "ready" });
}

start();
