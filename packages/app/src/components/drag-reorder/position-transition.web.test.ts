import { describe, expect, it } from "vitest";
import { transitionOffset } from "./position-transition.web";

describe("transitionOffset", () => {
  it("starts a moved cell at its previous painted position", () => {
    expect(transitionOffset({ previous: 0, top: -80, interruptedOffset: 0 })).toBe(80);
    expect(transitionOffset({ previous: -80, top: 0, interruptedOffset: 0 })).toBe(-80);
  });

  it("does not move a cell whose layout and paint are unchanged", () => {
    expect(transitionOffset({ previous: 40, top: 40, interruptedOffset: 0 })).toBeNull();
  });

  it("starts a reversed move from the interrupted painted offset", () => {
    expect(transitionOffset({ previous: 0, top: -80, interruptedOffset: 40 })).toBe(120);
  });

  it("settles a still-painted offset when the layout target did not change", () => {
    expect(transitionOffset({ previous: 40, top: 40, interruptedOffset: 25 })).toBe(25);
  });
});
