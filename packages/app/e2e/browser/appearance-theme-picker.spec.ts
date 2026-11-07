import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsSection } from "../support/helpers/settings";

test("shows Pure black in the appearance picker", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  await expect(page.getByRole("radio", { name: "System", exact: true })).toBeChecked();
  await expect(
    page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio").first(),
  ).toHaveAccessibleName("System");
  await expect(page.getByRole("radio", { name: "Pure black", exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("appearance-theme-picker.png"),
    fullPage: true,
  });
});

test("keeps the selected workspace visible in Light", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "light-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "light" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(212, 212, 216)");
    await page.screenshot({
      path: testInfo.outputPath("light-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("keeps the selected workspace visible in Pure black", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "pure-black-selected-workspace-",
    title: "Selected workspace",
  });

  try {
    await page.addInitScript(() => {
      localStorage.setItem("@paseo:app-settings", JSON.stringify({ theme: "pureBlack" }));
    });
    await gotoAppShell(page);

    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();

    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(row).toHaveCSS("background-color", "rgb(17, 17, 17)");
    await page.screenshot({
      path: testInfo.outputPath("pure-black-selected-workspace.png"),
      fullPage: true,
    });
  } finally {
    await workspace.cleanup();
  }
});

test("applies the interface font size to settings text", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiBaseFontSize: 21 }));
  });
  await page.goto("/settings");
  await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  await openSettingsSection(page, "appearance");

  const sectionTitle = page.getByText("Theme", { exact: true }).first();
  await expect(sectionTitle).toHaveCSS("font-size", "18px");

  const interfaceSizeInput = page.getByLabel("Interface font size");
  const contentSizeInput = page.getByLabel("Content font size");
  await expect(interfaceSizeInput).toHaveValue("21");
  await expect(contentSizeInput).toHaveValue("21");
  await interfaceSizeInput.fill("12");
  await interfaceSizeInput.press("Tab");

  await expect(interfaceSizeInput).toHaveValue("12");
  await expect(contentSizeInput).toHaveValue("21");
  await expect(sectionTitle).toHaveCSS("font-size", "10px");
});

/** Inspect the rendered swatches without changing the selected preference. */
function readOptionBackgrounds(buttons: Element[]): string[] {
  return buttons.map((button) => getComputedStyle(button).backgroundColor);
}

test("previews and retains accent colors independently of light and dark themes", async ({
  page,
}, testInfo) => {
  // Seed once: page.reload() re-runs init scripts, which would otherwise reset the saved choice.
  await page.addInitScript(() => {
    if (!localStorage.getItem("accent-test-seeded")) {
      localStorage.setItem(
        "@paseo:app-settings",
        JSON.stringify({ theme: "light", accentColor: "default" }),
      );
      localStorage.setItem("accent-test-seeded", "true");
    }
  });
  await page.goto("/settings");
  await openSettingsSection(page, "appearance");
  // The accent is a Paseo++ preference; Appearance has no accent picker.
  await expect(page.getByTestId("accent-color-settings")).toHaveCount(0);

  await openSettingsSection(page, "paseo-plus-plus");
  const accents = page.getByTestId("accent-color-settings");
  const options = accents.getByRole("radio");
  const defaultChoice = accents.getByRole("radio", { name: "Default", exact: true });
  const blue = accents.getByRole("radio", { name: "Blue", exact: true });
  const bubble = page.getByTestId("accent-message-preview-bubble");
  const text = page.getByTestId("accent-message-preview-text");
  await expect(options).toHaveCount(7);
  await expect(defaultChoice).toBeChecked();
  // Every swatch shows its own bubble color before it is chosen.
  expect(new Set(await options.evaluateAll(readOptionBackgrounds)).size).toBe(7);
  await expect(bubble).toHaveCSS("background-color", "rgb(228, 228, 231)");

  await blue.click();
  await expect(blue).toBeChecked();
  await expect(bubble).toHaveCSS("background-color", "rgb(62, 88, 114)");
  await expect(text).toHaveCSS("color", "rgb(255, 255, 255)");
  await page.reload();
  await expect(blue).toBeChecked();
  await expect(bubble).toHaveCSS("background-color", "rgb(62, 88, 114)");

  await openSettingsSection(page, "appearance");
  await page.getByLabel("Theme: Light", { exact: true }).click();
  await page.getByText("Dark", { exact: true }).click();
  await openSettingsSection(page, "paseo-plus-plus");
  await expect(blue).toBeChecked();
  await expect(bubble).toHaveCSS("background-color", "rgb(155, 175, 197)");
  await expect(text).toHaveCSS("color", "rgb(24, 24, 27)");
  await page.screenshot({ path: testInfo.outputPath("accent-blue-dark.png"), fullPage: true });

  // Default restores the dark theme's own surface3 bubble.
  await defaultChoice.click();
  await expect(defaultChoice).toBeChecked();
  await expect(bubble).toHaveCSS("background-color", "rgb(67, 70, 69)");
});
