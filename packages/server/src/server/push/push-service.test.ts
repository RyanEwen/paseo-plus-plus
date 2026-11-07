import type pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { PushService } from "./push-service.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

/**
 * Fake Expo push endpoint that rejects any request carrying more than one message,
 * the way Expo rejects a request whose tokens span projects (PUSH_TOO_MANY_EXPERIENCE_IDS).
 * Synthetic tokens never reach the real service. Records each token it accepts.
 */
function createSingleProjectExpo() {
  const delivered: string[] = [];
  const fetchImpl = async (_url: string | URL | Request, options?: RequestInit) => {
    const messages = JSON.parse(String(options?.body)) as Array<{ to: string }>;
    if (messages.length > 1) {
      return Response.json({ errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] }, { status: 400 });
    }
    delivered.push(messages[0].to);
    return Response.json({ data: [{ status: "ok", id: "test-ticket" }] });
  };
  return { delivered, fetchImpl: fetchImpl as typeof fetch };
}

describe("PushService", () => {
  test("sends each device token in its own request so Expo never sees a mixed-project batch", async () => {
    const expo = createSingleProjectExpo();
    const revokeToken = vi.fn();
    const service = new PushService(createLogger(), revokeToken, expo.fetchImpl);

    await service.sendPush(["development-device", "production-device"], {
      title: "Agent finished",
      body: "Done",
    });

    expect(expo.delivered).toEqual(["development-device", "production-device"]);
    expect(revokeToken).not.toHaveBeenCalled();
  });
});
