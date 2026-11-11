import { describe, expect, test } from "vitest";
import {
  dispatchExtensionApiRequest,
  unsupportedExtensionApi,
  type ExtensionApiHandler,
  type ExtensionApiRequest,
} from "./request-dispatch.js";

function call(method: string): ExtensionApiRequest<string> {
  return { method, args: [1], caller: { kind: "worker" }, extension: "fixture" };
}

describe("extension API dispatch", () => {
  const seen: string[] = [];
  const handlers: Record<string, ExtensionApiHandler<string>> = {
    tabs: (request) => {
      seen.push(request.method);
      return `tabs:${request.extension}:${String(request.args[0])}`;
    },
    alarms: (request) => {
      throw unsupportedExtensionApi(request.method);
    },
  };

  test("routes a method to the handler for its namespace", () => {
    expect(dispatchExtensionApiRequest(handlers, call("tabs.query"))).toBe("tabs:fixture:1");
    expect(seen).toContain("tabs.query");
  });

  test.each(["tabs", ".query", "storage.local.get", "constructor.call", "toString.x"])(
    "rejects %s as unsupported",
    (method) => {
      expect(() => dispatchExtensionApiRequest(handlers, call(method))).toThrow(
        `Extension API ${method} is not supported in Paseo.`,
      );
    },
  );

  test("a handler reports its own unsupported methods with the same error", () => {
    expect(() => dispatchExtensionApiRequest(handlers, call("alarms.create"))).toThrow(
      "Extension API alarms.create is not supported in Paseo.",
    );
  });
});
