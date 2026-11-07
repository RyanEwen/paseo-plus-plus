import type {
  BridgeDaemonTransportEvent,
  DaemonTransportBridge,
  OpenBridgeTransportSessionInput,
} from "./types";

type SendInput = Parameters<DaemonTransportBridge["sendMessage"]>[0];

/** An in-memory platform bridge whose listen, open and send calls settle when a test says so. */
export interface TestTransportBridge extends DaemonTransportBridge {
  readonly openCalls: readonly OpenBridgeTransportSessionInput[];
  readonly sends: readonly SendInput[];
  readonly closedSessions: readonly string[];
  /** Finish the pending listenToEvents call. */
  resolveListen(): void;
  /** Finish the pending openSession call. */
  resolveOpen(): void;
  /** Keep the next sendMessage call pending until the returned handle releases it. */
  holdNextSend(): { release(): void };
  /** Deliver one native event to the registered listener. */
  emitEvent(event: BridgeDaemonTransportEvent): void;
}

export function createTestTransportBridge(): TestTransportBridge {
  const openCalls: OpenBridgeTransportSessionInput[] = [];
  const sends: SendInput[] = [];
  const closedSessions: string[] = [];
  let eventHandler: ((event: BridgeDaemonTransportEvent) => void) | null = null;
  let finishListen: (() => void) | null = null;
  let finishOpen: (() => void) | null = null;
  let heldSend: Promise<void> | null = null;

  return {
    openCalls,
    sends,
    closedSessions,
    listenToEvents(handler) {
      eventHandler = handler;
      return new Promise((resolve) => {
        finishListen = () => resolve(() => {});
      });
    },
    openSession(input) {
      openCalls.push(input);
      return new Promise((resolve) => {
        finishOpen = resolve;
      });
    },
    async sendMessage(input) {
      sends.push(input);
      const pending = heldSend;
      heldSend = null;
      await pending;
    },
    async closeSession(sessionId) {
      closedSessions.push(sessionId);
    },
    resolveListen() {
      if (!finishListen) throw new Error("listenToEvents was not called");
      finishListen();
    },
    resolveOpen() {
      if (!finishOpen) throw new Error("openSession was not called");
      finishOpen();
    },
    holdNextSend() {
      let release = () => {};
      heldSend = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { release: () => release() };
    },
    emitEvent(event) {
      eventHandler?.(event);
    },
  };
}
