import { expect, type Page, type WebSocket } from "@playwright/test";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { projectEquivalenceViewKey } from "./project-view-key";

export interface RecoveryFrame {
  direction: "sent" | "received";
  message: SessionInboundMessage | SessionOutboundMessage;
}

/** True for the session messages a workspace recovery journey asserts on. */
function isRecoveryMessage(message: RecoveryFrame["message"] | undefined): boolean {
  return Boolean(
    message &&
    (message.type.startsWith("workspace.recovery.") || message.type === "refresh_agent_request"),
  );
}

/** Parse one text frame; binary terminal frames are outside recovery observation. */
function parseSessionMessage(payload: string | Buffer): RecoveryFrame["message"] | undefined {
  try {
    const envelope = JSON.parse(payload.toString()) as {
      type: string;
      message?: RecoveryFrame["message"];
    };
    return envelope.type === "session" ? envelope.message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Observe the real recovery exchanges on every daemon socket the page opens, without replacing a
 * WebSocket or its responses. Call `stop()` when the journey ends.
 */
export function recordRecoveryFrames(page: Page) {
  const frames: RecoveryFrame[] = [];
  const releases: Array<() => void> = [];
  const record = (direction: RecoveryFrame["direction"], payload: string | Buffer) => {
    const message = parseSessionMessage(payload);
    if (message && isRecoveryMessage(message)) {
      frames.push({ direction, message });
    }
  };
  const observeSocket = (socket: WebSocket) => {
    const sent = ({ payload }: { payload: string | Buffer }) => record("sent", payload);
    const received = ({ payload }: { payload: string | Buffer }) => record("received", payload);
    socket.on("framesent", sent);
    socket.on("framereceived", received);
    releases.push(() => {
      socket.off("framesent", sent);
      socket.off("framereceived", received);
    });
  };
  page.on("websocket", observeSocket);
  return {
    frames,
    stop: () => {
      page.off("websocket", observeSocket);
      for (const release of releases) release();
    },
  };
}

/** Open a project's kebab menu and choose one of its entries by test id prefix. */
export async function chooseProjectMenuEntry(
  page: Page,
  projectKey: string,
  entry: "restore" | "archive-all",
): Promise<void> {
  const viewKey = projectEquivalenceViewKey(projectKey);
  await page
    .getByTestId(`sidebar-project-row-${viewKey}`)
    .filter({ visible: true })
    .first()
    .hover();
  await page
    .getByTestId(`sidebar-project-kebab-${viewKey}`)
    .filter({ visible: true })
    .first()
    .click();
  await page
    .getByTestId(`sidebar-project-menu-${entry}-${viewKey}`)
    .filter({ visible: true })
    .first()
    .click();
}

/** Open the project's archive chooser from its menu. */
export async function openArchiveChooser(page: Page, projectKey: string) {
  await chooseProjectMenuEntry(page, projectKey, "restore");
  const chooser = page.getByTestId("restore-project-workspace-dialog");
  await expect(chooser).toBeVisible();
  return chooser;
}

/** Start Archive all for a project with background work and wait for its confirmation sheet. */
export async function openArchiveAllConfirmation(page: Page, projectKey: string) {
  await chooseProjectMenuEntry(page, projectKey, "archive-all");
  const confirmation = page.getByTestId("project-archive-confirmation");
  await expect(confirmation).toBeVisible();
  return confirmation;
}
