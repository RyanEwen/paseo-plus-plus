import { describe, expect, test } from "vitest";
import { AttachmentIdSchema } from "@getpaseo/protocol/attachments";
import { AttachmentReferenceIds } from "./reference-id.js";

describe("AttachmentReferenceIds", () => {
  test("ids match the wire schema and sort in minting order within one millisecond", () => {
    const ids = new AttachmentReferenceIds(() => 1_700_000_000_000);
    const minted = Array.from({ length: 50 }, () => ids.next());
    for (const id of minted) expect(AttachmentIdSchema.parse(id)).toBe(id);
    expect([...minted].sort()).toEqual(minted);
  });

  test("ids stay ordered when the clock moves backwards or the sequence is exhausted", () => {
    let now = 2_000;
    const ids = new AttachmentReferenceIds(() => now);
    const minted = [ids.next()];
    now = 1_000;
    minted.push(ids.next());
    now = 2_000;
    for (let index = 0; index < 0x1000 + 2; index++) minted.push(ids.next());
    expect([...minted].sort()).toEqual(minted);
    expect(new Set(minted).size).toBe(minted.length);
  });
});
