import { describe, expect, test } from "vitest";
import { AttentionPresentation } from "./presentation.js";

describe("AttentionPresentation.allowsNotification", () => {
  test.each([
    { enabled: true, knownAudience: true, delegated: true, intervention: false, allowed: true },
    { enabled: true, knownAudience: false, delegated: true, intervention: false, allowed: false },
    { enabled: true, knownAudience: false, delegated: false, intervention: false, allowed: true },
    { enabled: false, knownAudience: true, delegated: true, intervention: false, allowed: false },
    { enabled: false, knownAudience: false, delegated: false, intervention: false, allowed: true },
    { enabled: false, knownAudience: false, delegated: true, intervention: true, allowed: true },
    { enabled: true, knownAudience: false, delegated: true, intervention: true, allowed: true },
  ])(
    "enabled $enabled, known $knownAudience, delegated $delegated, intervention $intervention",
    ({ enabled, allowed, ...input }) => {
      const presentation = new AttentionPresentation();
      presentation.setAgentAware(enabled);
      expect(presentation.allowsNotification(input)).toBe(allowed);
    },
  );
});

describe("AttentionPresentation.project", () => {
  test.each([
    {
      name: "an explicit intervention shows in either mode",
      input: { enabled: false, humanAttentionRequired: false, requiresAttention: true },
      attentionMessage: "Pick an account",
      projected: true,
    },
    {
      name: "a known audience decision shows when enabled",
      input: { enabled: true, humanAttentionRequired: false, requiresAttention: true },
      attentionMessage: null,
      projected: false,
    },
    {
      name: "the decision is withheld when disabled",
      input: { enabled: false, humanAttentionRequired: true, requiresAttention: true },
      attentionMessage: null,
      projected: undefined,
    },
    {
      name: "an unknown audience stays unknown",
      input: { enabled: true, humanAttentionRequired: undefined, requiresAttention: false },
      attentionMessage: null,
      projected: undefined,
    },
  ])("$name", ({ input, attentionMessage, projected }) => {
    expect(AttentionPresentation.project({ ...input, attentionMessage })).toBe(projected);
  });
});
