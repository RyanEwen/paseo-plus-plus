import { describe, expect, it } from "vitest";
import {
  buildWindowsAgentToast,
  buildWindowsAgentNotificationArguments,
  classifyWindowsNotificationClose,
  createWindowsAgentNotificationOpener,
  createTimedOutNotificationRetention,
} from "./windows-agent-notification.js";

/** Builds a toast the way the desktop notification handler does. */
function chatToast(input: {
  title: string;
  body: string | undefined;
  data: Record<string, unknown>;
  iconPath: string | null;
  silent: boolean;
}): string {
  const { data, ...display } = input;
  const launch = buildWindowsAgentNotificationArguments({ notificationId: "notice-1", data });
  if (!launch) throw new Error("Chat target did not produce activation arguments");
  return buildWindowsAgentToast({ ...display, launch });
}

describe("Windows chat notification activation", () => {
  it("carries the chat target independently of the notification object and escapes its display content", () => {
    const toast = chatToast({
      title: 'Agent <ready> & "waiting"',
      body: "Ryan's chat",
      data: { serverId: "host/one", agentId: "chat one", workspaceId: "workspace-one" },
      iconPath: "C:\\Paseo & tools\\icon.png",
      silent: true,
    });
    expect(toast).toBe(
      '<toast launch="type=click&amp;tag=notice-1&amp;paseoAgent=paseo%3A%2F%2Fh%2Fhost%252Fone%2Fagent%2Fchat%2520one" activationType="foreground"><visual><binding template="ToastGeneric"><text>Agent &lt;ready&gt; &amp; &quot;waiting&quot;</text><text>Ryan&apos;s chat</text><image placement="appLogoOverride" hint-crop="none" src="C:\\Paseo &amp; tools\\icon.png"/></binding></visual><audio silent="true"/></toast>',
    );

    const links: string[] = [];
    createWindowsAgentNotificationOpener((url) => links.push(url))({
      type: "click",
      arguments:
        "type=click&tag=notice-1&paseoAgent=paseo%3A%2F%2Fh%2Fhost%252Fone%2Fagent%2Fchat%2520one",
    });
    expect(links).toEqual(["paseo://h/host%2Fone/agent/chat%20one"]);
  });

  it("keeps sound enabled and supports notifications with no body, icon, or workspace", () => {
    expect(
      chatToast({
        title: "Finished",
        body: undefined,
        data: { serverId: "host", agentId: "chat" },
        iconPath: null,
        silent: false,
      }),
    ).toBe(
      '<toast launch="type=click&amp;tag=notice-1&amp;paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat" activationType="foreground"><visual><binding template="ToastGeneric"><text>Finished</text></binding></visual></toast>',
    );
  });

  it("classifies Windows close callbacks without acknowledging programmatic or timed-out events", () => {
    expect(classifyWindowsNotificationClose({ reason: "userCanceled", programmatic: false })).toBe(
      "acknowledge",
    );
    expect(classifyWindowsNotificationClose({ reason: "userCanceled", programmatic: true })).toBe(
      "release",
    );
    expect(classifyWindowsNotificationClose({ reason: "timedOut", programmatic: false })).toBe(
      "retain",
    );
    expect(
      classifyWindowsNotificationClose({ reason: "applicationHidden", programmatic: false }),
    ).toBe("release");
    expect(classifyWindowsNotificationClose({ reason: undefined, programmatic: false })).toBe(
      "release",
    );
  });

  it("opens a foreground instance click and a durable activation only once, in either order", () => {
    for (const callbackOrder of [
      ["instance", "activation"],
      ["activation", "instance"],
    ]) {
      const links: string[] = [];
      const open = createWindowsAgentNotificationOpener((url) => links.push(url));
      const activation = {
        type: "click",
        arguments: "type=click&tag=notice-1&paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat",
      };
      const argumentsFromInstance = buildWindowsAgentNotificationArguments({
        notificationId: "notice-1",
        data: { serverId: "host", agentId: "chat" },
      });
      expect(argumentsFromInstance).toBe(activation.arguments);
      if (argumentsFromInstance === null) {
        throw new Error("Valid instance target did not produce activation arguments");
      }
      const instanceClick = { type: "click", arguments: argumentsFromInstance };
      for (const callback of callbackOrder) {
        open(callback === "instance" ? instanceClick : activation);
      }
      expect(links).toEqual(["paseo://h/host/agent/chat"]);
    }
  });

  it("opens instance-only and restart activations, including distinct notices for the same chat", () => {
    const links: string[] = [];
    const open = createWindowsAgentNotificationOpener((url) => links.push(url));
    for (const tag of ["foreground", "notification-center", "after-restart"]) {
      open({
        type: "click",
        arguments: `type=click&tag=${tag}&paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat`,
      });
    }
    expect(links).toEqual([
      "paseo://h/host/agent/chat",
      "paseo://h/host/agent/chat",
      "paseo://h/host/agent/chat",
    ]);
  });

  it("strips invalid XML controls while preserving Unicode and line breaks", () => {
    expect(
      chatToast({
        title: "Ready\u0000\u001b",
        body: "Chat 😀\nLine two\uD800",
        data: { serverId: "host", agentId: "chat" },
        iconPath: null,
        silent: false,
      }),
    ).toBe(
      '<toast launch="type=click&amp;tag=notice-1&amp;paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat" activationType="foreground"><visual><binding template="ToastGeneric"><text>Ready</text><text>Chat 😀\nLine two</text></binding></visual></toast>',
    );
  });

  it("does not turn a terminal or permission-test notification into a chat notification", () => {
    for (const data of [
      undefined,
      { serverId: "host", terminalId: "terminal" },
      { serverId: "host", agentId: " " },
    ]) {
      expect(buildWindowsAgentNotificationArguments({ notificationId: "notice-1", data })).toBe(
        null,
      );
    }
    const links: string[] = [];
    const open = createWindowsAgentNotificationOpener((url) => links.push(url));
    for (const input of [
      { type: "click", arguments: "" },
      { type: "click", arguments: "https://example.com" },
      {
        type: "reply",
        arguments: "type=click&tag=notice-1&paseoAgent=paseo%3A%2F%2Fh%2Fhost%2Fagent%2Fchat",
      },
    ]) {
      open(input);
    }
    expect(links).toEqual([]);
  });
});

describe("timed-out Windows notification retention", () => {
  it("releases the oldest retained notification once Notification Center's limit is exceeded", () => {
    const retention = createTimedOutNotificationRetention<string>(2);

    expect(retention.retain("first")).toEqual([]);
    expect(retention.retain("second")).toEqual([]);
    expect(retention.retain("third")).toEqual(["first"]);
  });

  it("does not count a released notification against the limit", () => {
    const retention = createTimedOutNotificationRetention<string>(2);
    retention.retain("first");
    retention.retain("second");

    retention.release("first");

    expect(retention.retain("third")).toEqual([]);
    expect(retention.retain("fourth")).toEqual(["second"]);
  });
});
