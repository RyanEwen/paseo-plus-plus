import { describe, expect, it, vi } from "vitest";
import { createTestTransportBridge } from "./test-transport-bridge";
import { createBridgeDaemonTransportFactory } from "./transport";

const LOCAL_URL = "paseo+desktop://socket?path=%2Ftmp%2Fpaseo.sock";

/** Open a transport on the test bridge and return the session id it registered. */
async function openTransport() {
  const bridge = createTestTransportBridge();
  const transport = createBridgeDaemonTransportFactory(bridge)({ url: LOCAL_URL });
  bridge.resolveListen();
  await Promise.resolve();
  const sessionId = bridge.openCalls[0].sessionId;
  return { bridge, transport, sessionId };
}

describe("createBridgeDaemonTransportFactory", () => {
  it("closes a bridge session that finishes opening after disposal", async () => {
    const { bridge, transport, sessionId } = await openTransport();

    transport.close();
    expect(bridge.closedSessions).toEqual([sessionId]);

    bridge.resolveOpen();
    await Promise.resolve();
    expect(bridge.closedSessions).toEqual([sessionId, sessionId]);
  });

  it("preserves text and binary frame order across asynchronous bridge calls", async () => {
    const { bridge, transport, sessionId } = await openTransport();
    bridge.emitEvent({ sessionId, kind: "open" });
    const firstSend = bridge.holdNextSend();

    transport.send("first");
    transport.send(new Uint8Array([1, 2, 3]));
    transport.send("last");
    await Promise.resolve();
    expect(bridge.sends).toEqual([{ sessionId, text: "first" }]);

    firstSend.release();
    await vi.waitFor(() => expect(bridge.sends).toHaveLength(3));
    expect(bridge.sends).toEqual([
      { sessionId, text: "first" },
      { sessionId, binaryBase64: "AQID" },
      { sessionId, text: "last" },
    ]);
    transport.close();
  });
});
