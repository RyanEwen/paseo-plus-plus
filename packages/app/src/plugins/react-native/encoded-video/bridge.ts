import type {
  EncodedVideoHandle,
  EncodedVideoProps,
  EncodedVideoFrame,
} from "@getpaseo/plugin/client/ui";
import {
  parseCanvasToHostMessage,
  type CanvasToHostMessage,
  type HostToCanvasCommand,
} from "./runtime/messages";

/** The WebView capability the bridge needs: running a script in the canvas document. */
export interface EncodedVideoTransport {
  injectJavaScript(script: string): void;
}

export type EncodedVideoCallbacks = Pick<
  EncodedVideoProps,
  "onReady" | "onFrame" | "onDequeue" | "onError"
>;

export interface EncodedVideoBridgeOptions {
  /** The mounted WebView, or null once React has cleared the native ref. */
  transport(): EncodedVideoTransport | null;
  /** The plugin's latest callbacks; read on every event so prop changes apply immediately. */
  callbacks(): EncodedVideoCallbacks;
  /**
   * Mount a fresh WebView document. Android does not restart a WebView whose render
   * process was killed; the dead view must be replaced before anything can report ready.
   */
  replaceDocument(): void;
}

export interface EncodedVideoBridge {
  /** The imperative handle the plugin receives through its ref. */
  readonly handle: EncodedVideoHandle;
  /** Handle one raw message posted by the canvas document. */
  receive(data: string): void;
  /** The WebView document failed or its render process stopped; it must report ready again. */
  documentFailed(error: Error): void;
  /** Android killed the WebView render process: fail like documentFailed, then load a new document. */
  renderProcessGone(): void;
  /** The component unmounted: reject pending paints and ignore all later output. */
  dispose(): void;
}

interface PendingPaint {
  resolve(): void;
  reject(error: Error): void;
}

/**
 * Host side of the Android video canvas: readiness, the generation fence, and pending paints.
 *
 * Every teardown (configure, reset, failure, unmount) advances `generation`; the canvas
 * echoes the generation it was given, so output from a replaced decoder is dropped here.
 */
export function createEncodedVideoBridge(options: EncodedVideoBridgeOptions): EncodedVideoBridge {
  let generation = 0;
  let nextRequest = 0;
  let ready = false;
  const pending = new Map<number, PendingPaint>();

  function rejectPending(error: Error): void {
    for (const paint of pending.values()) {
      paint.reject(error);
    }
    pending.clear();
  }

  function canSend(): boolean {
    return ready && options.transport() !== null;
  }

  /**
   * Deliver a command stamped with the current generation.
   *
   * Throws while the document is not ready. `reset` and `release` check `canSend` first
   * instead: React clears native refs before passive unmount cleanup, and a plugin's
   * decoder cleanup may still hold this handle during that interval.
   */
  function send(command: HostToCanvasCommand): void {
    const transport = options.transport();
    if (!ready || !transport) {
      throw new Error("Video decoder is not ready");
    }
    const payload = JSON.stringify({ ...command, generation });
    transport.injectJavaScript(`window.__PASEO_VIDEO__(${payload});true;`);
  }

  /** Codec errors keep the loaded document usable; the plugin may configure again. */
  function fail(error: Error): void {
    generation += 1;
    rejectPending(error);
    options.callbacks().onError(error);
  }

  function documentFailed(error: Error): void {
    ready = false;
    fail(error);
  }

  function settlePaint(requestId: number): void {
    pending.get(requestId)?.resolve();
    pending.delete(requestId);
  }

  function present(frameId: EncodedVideoFrame["id"]): Promise<void> {
    nextRequest += 1;
    const requestId = nextRequest;
    return new Promise<void>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        send({ type: "present", frameId, requestId });
      } catch (error) {
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  const handle: EncodedVideoHandle = {
    configure(config) {
      generation += 1;
      rejectPending(new Error("Video decoder replaced"));
      send({ type: "configure", config });
    },
    decode(chunk) {
      send({ type: "decode", chunk });
    },
    reset() {
      generation += 1;
      rejectPending(new Error("Video decoder reset"));
      if (canSend()) {
        send({ type: "reset" });
      }
    },
    present,
    release(frameId) {
      if (canSend()) {
        send({ type: "release", frameId });
      }
    },
  };

  function dispatch(message: CanvasToHostMessage): void {
    if (message.type === "ready") {
      ready = true;
      options.callbacks().onReady();
      return;
    }
    if (message.generation !== generation) {
      return;
    }
    switch (message.type) {
      case "error":
        fail(new Error(message.message));
        return;
      case "frame":
        options.callbacks().onFrame(message.frame);
        return;
      case "dequeue":
        options.callbacks().onDequeue();
        return;
      case "presented":
        settlePaint(message.requestId);
        return;
    }
  }

  return {
    handle,
    receive(data) {
      const message = parseCanvasToHostMessage(data);
      if (!message) {
        documentFailed(new Error("Invalid video decoder message"));
        return;
      }
      dispatch(message);
    },
    documentFailed,
    renderProcessGone() {
      documentFailed(new Error("Video decoder process stopped"));
      // Load and parse failures are not replaced: a document that fails deterministically
      // would reload forever. A killed renderer is transient (memory pressure).
      options.replaceDocument();
    },
    dispose() {
      ready = false;
      generation += 1;
      rejectPending(new Error("Video surface unmounted"));
    },
  };
}
