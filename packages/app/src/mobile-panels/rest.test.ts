import { describe, expect, it } from "vitest";
import {
  canBeginMobilePanelGesture,
  createMobilePanelMotionState,
  transitionMobilePanel,
} from "./model";

// rest.ts treats "a gesture may begin from this panel" as "this panel is at rest".
describe("mobile panel rest", () => {
  it("is not at rest during a gesture, even at the panel's anchor", () => {
    const state = createMobilePanelMotionState({ target: "agent", revision: 0 });
    const moving = transitionMobilePanel(state, { type: "gesture.begin", origin: "agent" }).state;

    expect(canBeginMobilePanelGesture(moving, "agent", 0)).toBe(false);
    expect(canBeginMobilePanelGesture(state, "agent", -0.5)).toBe(false);
    expect(canBeginMobilePanelGesture(state, "agent", 0)).toBe(true);
  });

  it("is not at rest while a command moves away and the position has not left the anchor", () => {
    const state = createMobilePanelMotionState({ target: "agent", revision: 0 });
    const moving = transitionMobilePanel(state, {
      type: "command",
      selection: { target: "agent-list", revision: 1 },
    }).state;

    expect(canBeginMobilePanelGesture(moving, "agent", 0)).toBe(false);
  });
});
