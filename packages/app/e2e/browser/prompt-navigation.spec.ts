import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  openAgentTimeline,
  originalUserMessages,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";

// Prompt navigation without a pinned prompt: arrows on each user message move between
// prompts, and the loading rail offers Cancel and Retry. Runs in the integration pass.

function userMessage(page: Page, prompt: string): Locator {
  return originalUserMessages(page).filter({ hasText: prompt });
}

/** Reveal the message's actions with a real hover, then press one of its arrows. */
async function pressPromptArrow(message: Locator, testID: string): Promise<void> {
  await message.hover();
  const arrow = message.getByTestId(testID);
  await expect(arrow).toBeEnabled();
  await arrow.click();
}

test("moves between prompts with the previous and next arrows", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await seedLongMockAgentTimeline({ turns: 3 });
  try {
    await openAgentTimeline(page, agent);
    const [first, second, third] = agent.prompts;
    await expect(userMessage(page, third!)).toBeVisible();

    await pressPromptArrow(userMessage(page, third!), "user-message-previous");
    await expect(userMessage(page, second!)).toBeInViewport();

    await pressPromptArrow(userMessage(page, second!), "user-message-previous");
    await expect(userMessage(page, first!)).toBeInViewport();
    await expect(userMessage(page, first!).getByTestId("user-message-previous")).toBeDisabled();

    await pressPromptArrow(userMessage(page, first!), "user-message-next");
    await expect(userMessage(page, second!)).toBeInViewport();
  } finally {
    await agent.cleanup();
  }
});

test("a failed prompt index shows Retry, and Retry restores navigation", async ({ page }) => {
  test.setTimeout(120_000);
  const agent = await seedLongMockAgentTimeline({ turns: 2 });
  const gate = await installDaemonWebSocketGate(page);
  try {
    gate.failPromptIndexResponses(agent.agentId);
    await openAgentTimeline(page, agent);
    const feedback = page.getByTestId("sticky-prompt-system-feedback");

    await expect(feedback.getByRole("alert")).toHaveText("Could not load user messages.");
    gate.allowPromptIndexResponses();
    await feedback.getByRole("button", { name: "Retry", exact: true }).click();

    await expect(feedback).toHaveCount(0);
    await pressPromptArrow(userMessage(page, agent.newestPrompt), "user-message-previous");
    await expect(userMessage(page, agent.oldestPrompt)).toBeInViewport();
  } finally {
    await agent.cleanup();
  }
});

test("prompt discovery with no prompt loaded offers Cancel while its index loads", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "prompt-navigation-discovery-",
    title: "Prompt navigation discovery",
  });
  const gate = await installDaemonWebSocketGate(page);
  // Whole-turn pages would load the user row with the tail, leaving nothing to discover.
  gate.stripWholeTurnTimeline();
  try {
    await agent.client.sendAgentMessage(
      agent.agentId,
      "emit 85 assistant messages before synthetic user message",
    );
    await agent.client.waitForFinish(agent.agentId, 15_000);
    // The retained-context lookup also reads the index; it must not supply the prompt.
    gate.failPromptIndexResponses(agent.agentId);
    gate.holdNextServerMessage("agent.timeline.list_prompts.response");
    await openAgentTimeline(page, agent);
    await gate.waitForHeldServerMessage("agent.timeline.list_prompts.response");
    const feedback = page.getByTestId("sticky-prompt-system-feedback");

    await feedback.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect(feedback).toContainText("Loading cancelled.");
    await expect(feedback.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    gate.releaseHeldServerMessage("agent.timeline.list_prompts.response");
  } finally {
    await agent.cleanup();
  }
});
