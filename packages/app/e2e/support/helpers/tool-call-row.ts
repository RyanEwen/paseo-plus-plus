import { expect, type Locator } from "@playwright/test";

/**
 * Expect the first tool-call row after `anchor` (for example the assistant message that opened a
 * turn) to show exactly `label` and `summary`. Rows before the anchor, such as an earlier turn's
 * identical operations, never satisfy it.
 */
export async function expectToolCallRowAfter(
  anchor: Locator,
  row: { label: string; summary: string },
): Promise<void> {
  const page = anchor.page();
  const badge = anchor
    .locator('xpath=following::*[@data-testid="tool-call-badge"]')
    .filter({ has: page.getByText(row.label, { exact: true }) })
    .filter({ has: page.getByText(row.summary, { exact: true }) })
    .first();
  await expect(badge).toBeVisible({ timeout: 30_000 });
}
