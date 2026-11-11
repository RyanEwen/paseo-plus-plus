import { randomBytes } from "node:crypto";

/**
 * Mints attachment reference IDs that sort by creation time.
 *
 * IDs are `att_` plus an RFC 9562 UUID version 7: a 48-bit Unix millisecond timestamp, then a
 * 12-bit sequence and random bits. The sequence increments within one millisecond, and the
 * timestamp never moves backwards within a process, so string order matches minting order
 * and the list cursor pages oldest first. The shape still matches `AttachmentIdSchema`.
 */
export class AttachmentReferenceIds {
  private lastMs = 0;
  private sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  next(): string {
    let ms = Math.max(this.now(), this.lastMs);
    if (ms === this.lastMs) {
      this.sequence++;
      // The 12-bit sequence is exhausted: borrow the next millisecond to stay ordered.
      if (this.sequence > 0xfff) {
        ms++;
        this.sequence = 0;
      }
    } else {
      this.sequence = 0;
    }
    this.lastMs = ms;
    return `att_${formatUuidV7(ms, this.sequence)}`;
  }
}

function formatUuidV7(ms: number, sequence: number): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
