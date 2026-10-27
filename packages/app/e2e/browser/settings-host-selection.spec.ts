import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import { claudeAndCodexReports, usageItem } from "../support/helpers/usage-sidebar-item";
import { setFooterItemVisible } from "../support/helpers/sidebar-nav-settings";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient, loadProtocolSchemas } from "../support/helpers/daemon-client-loader";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import {
  loadSessionMessageReaders,
  connectNewWorkspaceDaemonClient,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import { openSettings } from "../support/helpers/app";
import { getE2EDaemonPort, wsRoutePatternForPort } from "../support/helpers/daemon-port";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  addDirectHostFromSettings,
  clickSettingsBackToWorkspace,
  openSettingsHostSection,
  selectSettingsHost,
} from "../support/helpers/settings";
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
    } finally {
      await remoteWorkspace.cleanup().catch(() => undefined);
      await remoteDaemon.close().catch(() => undefined);
    }
  });
});

test("explicit settings host sync shares preferences across independent clients without overwriting an initialized host", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const admin = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "settings-sync-proof" });
  const remote = await startIsolatedHostDaemon("settings-sync-other-host");
  console.log(
    `[sync-qa] secondary daemon port=${remote.port} home=${remote.paseoHome} pid=${remote.getPid()}`,
  );
  const remoteClient = await connectDaemonClient<DaemonClient>({
    clientIdPrefix: "settings-sync-other",
    port: remote.port,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const second = await context.newPage();
  const evidence = resolve("../../docs/qa-evidence/app-settings-sync");
  mkdirSync(evidence, { recursive: true });
  try {
    await installUsageReportsFixture(page, { lists: [() => claudeAndCodexReports()] });
    await installUsageReportsFixture(second, { lists: [() => claudeAndCodexReports()] });
    await remoteClient.patchAppSettings(
      [{ path: ["app", "paseoPlusPlus", "stickyUserPrompts"], value: false, expectedRevision: 0 }],
      true,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(buildSettingsSectionRoute("paseo-plus-plus"));
    const sync = page.getByTestId("settings-sync");
    await expect(sync).toContainText("Preferences are saved on this device");
    const registry = await page.evaluate(() => localStorage.getItem("@paseo:daemon-registry"));
    const profiles = JSON.parse(registry!) as { label: string; serverId: string }[];
    const hostLabel = profiles[0]!.label;
    await sync
      .getByRole("button", { name: "Settings host: This device only", exact: true })
      .click();
    await page.getByRole("menuitem", { name: hostLabel, exact: true }).click();
    await expect(sync).toContainText("No settings published on this host");
    expect((await admin.getAppSettings()).snapshot.initialized).toBe(false);
    await page.screenshot({ path: resolve(evidence, "empty-host-1440.png") });
    await sync.getByRole("button", { name: "Use this device settings", exact: true }).click();
    await expect(sync).toContainText("Connected. Pending changes: 0");
    await page.getByTestId("paseo-plus-plus-previousAgents").getByRole("switch").click();
    await expect
      .poll(async () => (await admin.getAppSettings()).snapshot.values.app)
      .toMatchObject({ paseoPlusPlus: { previousAgents: false } });

    await second.addInitScript(
      ({ savedRegistry }) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", savedRegistry!);
        localStorage.setItem(
          "@paseo:app-settings",
          JSON.stringify({ paseoPlusPlus: { previousAgents: true } }),
        );
      },
      { savedRegistry: registry },
    );
    await second.goto(new URL(buildSettingsSectionRoute("paseo-plus-plus"), page.url()).href);
    const secondSync = second.getByTestId("settings-sync");
    await secondSync
      .getByRole("button", { name: "Settings host: This device only", exact: true })
      .click();
    await second.getByRole("menuitem", { name: hostLabel, exact: true }).click();
    await expect(secondSync).toContainText("Connected. Pending changes: 0");
    await expect(
      second.getByTestId("paseo-plus-plus-previousAgents").getByRole("switch"),
    ).not.toBeChecked();
    await second.getByTestId("paseo-plus-plus-sidebarProjectSelector").getByRole("switch").click();
    await expect(
      page.getByTestId("paseo-plus-plus-sidebarProjectSelector").getByRole("switch"),
    ).not.toBeChecked();
    // Keep B on the ordinary sidebar before toggling A, so visibility proves a live update.
    await second.goto(new URL("/", page.url()).href);
    await expect(second.locator('[data-testid="sidebar-usage"]:visible')).toHaveCount(0);
    // Usage visibility is the footer preference, independent of the selected usage-report host.
    await page.goto(buildSettingsSectionRoute("sidebar"));
    await setFooterItemVisible(page, "usage", true);
    await expect(usageItem(second)).toBeVisible();
    await second.reload();
    await expect(usageItem(second)).toBeVisible();
    await page.screenshot({ path: resolve(evidence, "usage-enabled-on-client-a.png") });
    await second.screenshot({
      path: resolve(evidence, "usage-enabled-on-client-b-after-reload.png"),
    });
    await setFooterItemVisible(page, "usage", false);
    await expect(second.locator('[data-testid="sidebar-usage"]:visible')).toHaveCount(0);
    await page.goto(buildSettingsSectionRoute("paseo-plus-plus"));
    await page.screenshot({ path: resolve(evidence, "shared-preferences-1440.png") });
    await second.goto(new URL(buildSettingsSectionRoute("paseo-plus-plus"), page.url()).href);
    await second.setViewportSize({ width: 390, height: 900 });
    // The responsive screen remounts at the breakpoint; assertions resolve its current node.
    await expect(secondSync).toBeVisible();
    await expect(secondSync).toBeInViewport();
    await expect
      .poll(() => second.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 390, height: 900 });
    await second.screenshot({ path: resolve(evidence, "shared-preferences-390.png") });

    await addDirectHostFromSettings(page, { host: "127.0.0.1", port: remote.port });
    const remoteLabel = await page.evaluate((serverId) => {
      const hosts = JSON.parse(localStorage.getItem("@paseo:daemon-registry")!);
      const profile = hosts.find(
        (host: { serverId: string; label: string }) => host.serverId === serverId,
      );
      localStorage.setItem(
        "@paseo:e2e-disable-default-seed-once",
        localStorage.getItem("@paseo:e2e-seed-nonce")!,
      );
      return profile.label as string;
    }, remote.serverId);
    await page.goto(buildSettingsSectionRoute("paseo-plus-plus"));
    const beforeSwitch = (await remoteClient.getAppSettings()).snapshot;
    await sync.getByRole("button", { name: `Settings host: ${hostLabel}`, exact: true }).click();
    await page.getByRole("menuitem", { name: remoteLabel, exact: true }).last().click();
    await expect(sync).toContainText("Connected. Pending changes: 0");
    await expect(
      page.getByTestId("paseo-plus-plus-stickyUserPrompts").getByRole("switch"),
    ).not.toBeChecked();
    expect((await remoteClient.getAppSettings()).snapshot).toEqual(beforeSwitch);
  } finally {
    await context.close();
    await admin.close();
    await remoteClient.close();
    await remote.close();
  }
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
