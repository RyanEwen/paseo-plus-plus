import { describe, expect, it } from "vitest";
import type { OsNotificationPayload } from "@/utils/os-notifications";
import { sendWorkspaceOsNotification } from "./workspace-notification";

describe("Workspace notification enrichment", () => {
  const payload = {
    title: "Workspace",
    body: "Agent finished\nDone",
    data: { serverId: "host", workspaceId: "workspace", agentId: "agent" },
  };

  it("delivers the original alert once when icon lookup rejects", async () => {
    const sent: OsNotificationPayload[] = [];
    expect(
      await sendWorkspaceOsNotification(payload, {
        async getIcon() {
          throw new Error("Host disconnected");
        },
        async send(notification) {
          sent.push(notification);
          return true;
        },
      }),
    ).toBe(true);
    expect(sent).toEqual([payload]);
  });

  it("delivers once after the icon budget and ignores a late lookup result", async () => {
    const sent: OsNotificationPayload[] = [];
    let finishLookup: (icon: string) => void = () => {};
    const icon = new Promise<string>((resolve) => {
      finishLookup = resolve;
    });
    expect(
      await sendWorkspaceOsNotification(payload, {
        getIcon: () => icon,
        async send(notification) {
          sent.push(notification);
          return true;
        },
      }),
    ).toBe(true);
    finishLookup("data:image/png;base64,late");
    await icon;
    expect(sent).toEqual([payload]);
  });

  it("attaches a ready icon while preserving routing and delivery failure", async () => {
    const sent: OsNotificationPayload[] = [];
    expect(
      await sendWorkspaceOsNotification(payload, {
        async getIcon() {
          return "data:image/png;base64,ready";
        },
        async send(notification) {
          sent.push(notification);
          return false;
        },
      }),
    ).toBe(false);
    expect(sent).toEqual([{ ...payload, icon: "data:image/png;base64,ready" }]);
  });
});
