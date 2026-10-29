import { expect, test as base } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addConnectedHostAndReload,
  chooseHostBadgeDisplay,
  chooseHostColor,
  expectHostAppearancePreview,
  expectHostBadgeIconOnly,
  expectHostBadgeName,
  expectHostBadgeTinted,
  expectNoHostBadge,
  leaveHostAppearanceSettings,
  openHostAppearanceSettings,
  reloadPreservingHostRegistry,
  renameHostFromSettings,
  waitForConnectedHost,
} from "../support/helpers/hosts";
import {
  type IsolatedHostDaemon,
  startIsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import {
  closeSidebarDisplayPreferences,
  openSidebarDisplayPage,
  pinWorkspaceFromSidebar,
  selectSidebarProjectGrouping,
  selectSidebarStatusGrouping,
} from "../support/helpers/sidebar";
import type { Page } from "@playwright/test";

const PRIMARY_HOST_LABEL = "Primary Host";
const SECONDARY_HOST_LABEL = "Secondary Host";

interface TwoHostSidebar {
  primaryServerId: string;
  primaryWorkspaceId: string;
  secondaryServerId: string;
  secondaryWorkspaceId: string;
}

// The host badge only appears once the visible sidebar spans more than one host, and that count
// runs over visible projects — so an offline host with no workspaces will not raise it. Two real
// daemons, each with a seeded workspace, is the minimum shape that exercises the feature.
const test = base.extend<{ twoHostSidebar: TwoHostSidebar }>({
  twoHostSidebar: async ({ page }, provide) => {
    const secondaryHost: IsolatedHostDaemon = await startIsolatedHostDaemon(
      "host-appearance-secondary",
    );
    let primary: SeededWorkspace | null = null;
    let secondary: SeededWorkspace | null = null;

    try {
      primary = await seedWorkspace({
        repoPrefix: "host-appearance-primary-",
        title: "Primary workspace",
      });
      secondary = await seedWorkspace({
        repoPrefix: "host-appearance-secondary-",
        title: "Secondary workspace",
        port: secondaryHost.port,
      });

      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryHost.serverId,
        label: SECONDARY_HOST_LABEL,
        port: secondaryHost.port,
        primaryLabel: PRIMARY_HOST_LABEL,
      });
      await waitForConnectedHost(page, {
        serverId: secondaryHost.serverId,
        endpoint: `localhost:${secondaryHost.port}`,
      });
      await waitForSidebarHydration(page);

      await provide({
        primaryServerId: getServerId(),
        primaryWorkspaceId: primary.workspaceId,
        secondaryServerId: secondaryHost.serverId,
        secondaryWorkspaceId: secondary.workspaceId,
      });
    } finally {
      await primary?.cleanup().catch(() => undefined);
      await secondary?.cleanup().catch(() => undefined);
      await secondaryHost.close().catch(() => undefined);
    }
  },
});

test.describe.configure({ timeout: 180_000 });

/** Change the active mode's Host switch through the same menu as a user. */
async function toggleSidebarHost(page: Page): Promise<void> {
  await openSidebarDisplayPage(page, "sidebar-display-show");
  await page.getByTestId("sidebar-row-item-host").click();
  await closeSidebarDisplayPreferences(page);
}

test("honors each mode's Host switch for pinned and grouped rows without losing host appearance", async ({
  page,
  twoHostSidebar,
}) => {
  const primary = {
    serverId: twoHostSidebar.primaryServerId,
    workspaceId: twoHostSidebar.primaryWorkspaceId,
    hostName: PRIMARY_HOST_LABEL,
  };
  const secondary = {
    serverId: twoHostSidebar.secondaryServerId,
    workspaceId: twoHostSidebar.secondaryWorkspaceId,
    hostName: SECONDARY_HOST_LABEL,
  };
  const primaryRowId = `sidebar-workspace-row-${primary.serverId}:${primary.workspaceId}`;
  const secondaryRowId = `sidebar-workspace-row-${secondary.serverId}:${secondary.workspaceId}`;
  const pinnedPrimary = page.getByTestId("sidebar-pinned-section").getByTestId(primaryRowId);
  const groupedRows = page.locator('[data-testid^="sidebar-status-group-rows-"]');
  const expectStatusMembership = async () => {
    await expect(pinnedPrimary).toBeVisible();
    await expect(page.getByTestId(primaryRowId)).toHaveCount(1);
    await expect(groupedRows.getByTestId(primaryRowId)).toHaveCount(0);
    await expect(groupedRows.getByTestId(secondaryRowId)).toBeVisible();
  };
  await openHostAppearanceSettings(page, secondary.serverId);
  await chooseHostBadgeDisplay(page, "Icon only");
  await leaveHostAppearanceSettings(page);
  await pinWorkspaceFromSidebar(page, primary.workspaceId);
  await expect(pinnedPrimary).toBeVisible();
  await selectSidebarStatusGrouping(page);
  await expectStatusMembership();
  await expectHostBadgeName(page, primary);
  await expectHostBadgeIconOnly(page, secondary);

  await toggleSidebarHost(page);
  await expectNoHostBadge(page, primary);
  await expectNoHostBadge(page, secondary);
  await expect(
    page.getByTestId(`sidebar-row-project-icon-${secondary.serverId}:${secondary.workspaceId}`),
  ).toBeVisible();
  await expectStatusMembership();

  // Project mode retains its own Host choice; returning to Status restores its hidden choice.
  await selectSidebarProjectGrouping(page);
  await expect(pinnedPrimary).toBeVisible();
  await expectHostBadgeName(page, primary);
  await expectHostBadgeIconOnly(page, secondary);
  await selectSidebarStatusGrouping(page);
  await expectStatusMembership();
  await expectNoHostBadge(page, primary);
  await expectNoHostBadge(page, secondary);

  await toggleSidebarHost(page);
  await expectStatusMembership();
  await expectHostBadgeName(page, primary);
  await expectHostBadgeIconOnly(page, secondary);
});

test("customizes a host badge and preserves its appearance after reload", async ({
  page,
  twoHostSidebar,
}) => {
  const badge = {
    serverId: twoHostSidebar.secondaryServerId,
    workspaceId: twoHostSidebar.secondaryWorkspaceId,
  };
  const hostName = "Developer MacBook Pro.local";

  await test.step("rename the host and use its available sidebar width", async () => {
    await expectHostBadgeName(page, { ...badge, hostName: SECONDARY_HOST_LABEL });
    await openHostAppearanceSettings(page, badge.serverId);
    await renameHostFromSettings(page, hostName);
    await leaveHostAppearanceSettings(page);
    await expectHostBadgeName(page, { ...badge, hostName });

    const row = page.getByTestId(`sidebar-workspace-row-${badge.serverId}:${badge.workspaceId}`);
    const hostBadge = row.getByTestId(`host-badge-${badge.serverId}`);
    const [badgeBox, rowBox] = await Promise.all([hostBadge.boundingBox(), row.boundingBox()]);
    expect(badgeBox).not.toBeNull();
    expect(rowBox).not.toBeNull();
    expect(badgeBox!.width).toBeGreaterThan(96);
    expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width);
    const widths = await hostBadge.getByText(hostName, { exact: true }).evaluate((label) => ({
      client: label.clientWidth,
      content: label.scrollWidth,
    }));
    expect(widths.content).toBeLessThanOrEqual(widths.client);
  });

  await test.step("preview a color and apply it to the sidebar badge", async () => {
    await openHostAppearanceSettings(page, badge.serverId);
    await chooseHostColor(page, "Teal");
    await expectHostAppearancePreview(page, { serverId: badge.serverId, hostName, color: "teal" });
    await leaveHostAppearanceSettings(page);
    await expectHostBadgeTinted(page, { ...badge, hostName, color: "teal" });
  });

  await test.step("keep the icon-only preference through reload", async () => {
    await openHostAppearanceSettings(page, badge.serverId);
    await chooseHostBadgeDisplay(page, "Icon only");
    await leaveHostAppearanceSettings(page);
    await expectHostBadgeIconOnly(page, { ...badge, hostName });
    await reloadPreservingHostRegistry(page);
    await waitForSidebarHydration(page);
    await expectHostBadgeIconOnly(page, { ...badge, hostName });
  });

  await test.step("hide this badge without hiding the other host", async () => {
    await openHostAppearanceSettings(page, badge.serverId);
    await chooseHostBadgeDisplay(page, "Hidden");
    await leaveHostAppearanceSettings(page);
    await expectNoHostBadge(page, { ...badge, hostName });
    await expectHostBadgeName(page, {
      serverId: twoHostSidebar.primaryServerId,
      workspaceId: twoHostSidebar.primaryWorkspaceId,
      hostName: PRIMARY_HOST_LABEL,
    });
  });
});
