import { test, expect } from "../support/fixtures";
import { connectDaemonClient, loadProtocolSchemas } from "../support/helpers/daemon-client-loader";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import type { Page } from "@playwright/test";
import {
  loadSessionMessageReaders,
  connectNewWorkspaceDaemonClient,
} from "../support/helpers/new-workspace";
import { openSettings } from "../support/helpers/app";
import { getE2EDaemonPort, wsRoutePatternForPort } from "../support/helpers/daemon-port";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  addDirectHostFromSettings,
  clickSettingsBackToWorkspace,
  openSettingsHostSection,
  openSettingsSection,
  selectSettingsHost,
} from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";

test.describe("Settings host selection", () => {
  test.describe.configure({ timeout: 180_000 });

  test("entering Settings from a remote workspace selects that remote host", async ({ page }) => {
    const remoteDaemon = await startIsolatedHostDaemon("settings-host-selection-remote");
    const remoteWorkspace = await seedWorkspace({
      port: remoteDaemon.port,
      repoPrefix: "settings-host-selection-remote-workspace-",
      title: "Remote workspace",
    });

    try {
      // The default local profile remains in the registry, but its daemon is offline.
      await page.routeWebSocket(wsRoutePatternForPort(getE2EDaemonPort()), async (ws) => {
        await ws.close({ code: 1008, reason: "The local daemon is disconnected." });
      });

      await page.goto("/");
      await openSettings(page);
      await addDirectHostFromSettings(page, {
        host: "127.0.0.1",
        port: remoteDaemon.port,
      });

      await clickSettingsBackToWorkspace(page);
      await switchWorkspaceViaSidebar({
        page,
        serverId: remoteDaemon.serverId,
        workspaceId: remoteWorkspace.workspaceId,
      });

      await openSettings(page);

      await openSettingsHostSection(page, remoteDaemon.serverId, "connections");

      await selectSettingsHost(page, getServerId());
      await openSettingsSection(page, "appearance");
      await openSettingsHostSection(page, getServerId(), "connections");

      await clickSettingsBackToWorkspace(page);
      await openSettings(page);
      await openSettingsHostSection(page, remoteDaemon.serverId, "connections");
    } finally {
      await remoteWorkspace.cleanup().catch(() => undefined);
      await remoteDaemon.close().catch(() => undefined);
    }
  });
});

/** Renderer-only negotiation/failure fixture, not evidence that a real host advertises this staged feature. */
async function attentionSettingsFrames(page: Page, port: string, supported: boolean) {
  const readers = await loadSessionMessageReaders();
  const { parseServerInfoStatusPayload } = await loadProtocolSchemas();
  const requests: string[] = [];
  const entered = Promise.withResolvers<void>();
  let release = () => {};
  let hold = supported;
  await page.routeWebSocket(wsRoutePatternForPort(port), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((frame) => {
      const request = readers.client(frame);
      if (request?.type === "set_daemon_config_request") {
        requests.push(request.requestId);
        if (hold) {
          hold = false;
          release = () =>
            browser.send(
              JSON.stringify({
                type: "session",
                message: {
                  type: "rpc_error",
                  payload: {
                    requestId: request.requestId,
                    requestType: request.type,
                    error: "Attention preference save rejected",
                    code: "handler_error",
                  },
                },
              }),
            );
          entered.resolve();
          return;
        }
      }
      server.send(frame);
    });
    server.onMessage((frame) => {
      const message = readers.server(frame);
      const info =
        message?.type === "status" ? parseServerInfoStatusPayload(message.payload) : null;
      if (info) {
        browser.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                ...info,
                features: {
                  ...info.features,
                  agentAudienceAttentionSettings: supported,
                },
              },
            },
          }),
        );
      } else browser.send(frame);
    });
  });
  return { entered: entered.promise, rejectHeld: () => release(), requests };
}

test("attention preference renderer requires host capability without writing a device preference", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "attention-settings-unsupported-" });
  try {
    const frames = await attentionSettingsFrames(page, getE2EDaemonPort(), false);
    await page.goto(buildSettingsSectionRoute("notifications"));
    await expect(
      page.getByTestId("agent-aware-attention-setting").getByRole("switch"),
    ).toBeDisabled();
    await expect(page.getByText("Update this host to change agent-aware attention.")).toBeVisible();
    expect(frames.requests).toEqual([]);
  } finally {
    await workspace.cleanup();
  }
});

test("attention preference renderer keeps committed value during pending failure then retries one host", async ({
  page,
}) => {
  const daemon = await startIsolatedHostDaemon("attention-settings-renderer");
  const workspace = await seedWorkspace({
    port: daemon.port,
    repoPrefix: "attention-settings-host-",
  });
  let frames: Awaited<ReturnType<typeof attentionSettingsFrames>> | undefined;
  let configClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>> | undefined;
  try {
    configClient = await connectNewWorkspaceDaemonClient({ port: daemon.port, ownProjects: false });
    frames = await attentionSettingsFrames(page, String(daemon.port), true);
    await page.goto("/");
    await openSettings(page);
    await addDirectHostFromSettings(page, { host: "127.0.0.1", port: daemon.port });
    await clickSettingsBackToWorkspace(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: daemon.serverId,
      workspaceId: workspace.workspaceId,
    });
    await openSettings(page);
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    const control = page.getByTestId("agent-aware-attention-setting").getByRole("switch");
    await expect(control).toBeEnabled();
    await expect(control).toHaveAttribute("aria-checked", "true");
    await control.click();
    await frames.entered;
    await expect(control).toBeDisabled();
    await expect(control).toHaveAttribute("aria-checked", "true");
    frames.rejectHeld();
    await expect(
      page.getByRole("alert").filter({ hasText: "Attention preference save rejected" }),
    ).toBeVisible();
    await expect(control).toBeEnabled();
    await control.click();
    await expect(control).toHaveAttribute("aria-checked", "false");
    expect((await configClient.getDaemonConfig()).config.notifications?.agentAwareAttention).toBe(
      false,
    );
    expect(frames.requests).toHaveLength(2);
  } finally {
    frames?.rejectHeld();
    await configClient?.close();
    await workspace.cleanup();
    await daemon.close();
  }
});

test("attention preference renderer retires pending A controls when settings host changes to B", async ({
  page,
}) => {
  const a = await startIsolatedHostDaemon("attention-settings-host-a");
  const aWorkspace = await seedWorkspace({ port: a.port, repoPrefix: "attention-settings-a-" });
  const bWorkspace = await seedWorkspace({ repoPrefix: "attention-settings-b-" });
  let aFrames: Awaited<ReturnType<typeof attentionSettingsFrames>> | undefined;
  let aConfig: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>> | undefined;
  let bConfig: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>> | undefined;
  try {
    aConfig = await connectNewWorkspaceDaemonClient({ port: a.port, ownProjects: false });
    bConfig = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const bBefore = (await bConfig.getDaemonConfig()).config;
    aFrames = await attentionSettingsFrames(page, String(a.port), true);
    const bFrames = await attentionSettingsFrames(page, getE2EDaemonPort(), true);
    await page.goto("/");
    await openSettings(page);
    await addDirectHostFromSettings(page, { host: "127.0.0.1", port: a.port });
    await clickSettingsBackToWorkspace(page);
    await switchWorkspaceViaSidebar({
      page,
      serverId: a.serverId,
      workspaceId: aWorkspace.workspaceId,
    });
    await openSettings(page);
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    const control = page.getByTestId("agent-aware-attention-setting").getByRole("switch");
    await expect(control).toBeEnabled();
    await control.click();
    await aFrames.entered;
    await expect(control).toBeDisabled();
    await selectSettingsHost(page, getServerId());
    await expect(control).toBeEnabled();
    await expect(control).toHaveAttribute("aria-checked", "true");
    aFrames.rejectHeld();
    await expect(control).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("alert").filter({ hasText: "Attention preference save rejected" }),
    ).toHaveCount(0);
    expect(bFrames.requests).toEqual([]);
    expect((await bConfig.getDaemonConfig()).config).toEqual(bBefore);
    expect((await aConfig.getDaemonConfig()).config.notifications?.agentAwareAttention).not.toBe(
      false,
    );
  } finally {
    aFrames?.rejectHeld();
    await aConfig?.close();
    await bConfig?.close();
    await aWorkspace.cleanup();
    await bWorkspace.cleanup();
    await a.close();
  }
});
