import { describe, expect, it } from "vitest";
import type { AppSettingsPatch, AppSettingsSnapshot } from "@getpaseo/protocol/app-settings";
import { dropAcknowledged, dropAlreadyDurable, mergePending, rebaseOnto } from "./outbox";

/** A host document with one revision per stored leaf. */
function hostSnapshot(
  values: Record<string, unknown>,
  revisions: Record<string, number>,
): AppSettingsSnapshot {
  return {
    initialized: true,
    revision: Math.max(0, ...Object.values(revisions)),
    values,
    fieldRevisions: revisions,
  };
}

function theme(value: string, expectedRevision: number): AppSettingsPatch {
  return { path: ["app", "theme"], value, expectedRevision };
}

const language: AppSettingsPatch = { path: ["app", "language"], value: "fr", expectedRevision: 1 };

describe("settings outbox", () => {
  it("merges a repeated leaf edit, keeping the first edit's expected revision", () => {
    const pending = mergePending([theme("dark", 2), language], [theme("light", 5)]);
    expect(pending).toEqual([theme("light", 2), language]);
  });

  it("drops edits the host already stores", () => {
    const snapshot = hostSnapshot({ app: { theme: "dark" } }, { '["app","theme"]': 3 });
    expect(dropAlreadyDurable([theme("dark", 1), language], snapshot)).toEqual([language]);
  });

  it("rebases every edit onto the host's current revisions", () => {
    const snapshot = hostSnapshot({}, { '["app","theme"]': 7 });
    expect(rebaseOnto([theme("dark", 1), language], snapshot)).toEqual([
      theme("dark", 7),
      { ...language, expectedRevision: 0 },
    ]);
  });

  it("acknowledges unchanged sent edits and re-expects a leaf edited during the write", () => {
    const sent = [theme("dark", 1), language];
    const pending = [theme("light", 1), language];
    const result = {
      snapshot: hostSnapshot({}, { '["app","theme"]': 4, '["app","language"]': 4 }),
      conflicts: [],
    };
    expect(dropAcknowledged(pending, sent, result)).toEqual([theme("light", 4)]);
    // The caller's list is never mutated.
    expect(pending).toEqual([theme("light", 1), language]);
  });

  it("keeps every edit unchanged when the write reported conflicts", () => {
    const sent = [theme("dark", 1)];
    const result = { snapshot: hostSnapshot({}, {}), conflicts: [["app", "theme"]] };
    expect(dropAcknowledged(sent, sent, result)).toEqual(sent);
  });
});
