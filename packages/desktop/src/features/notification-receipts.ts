import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  NotificationDismissalSchema,
  NotificationReceiptDataSchema,
  type NotificationDismissal,
} from "@getpaseo/protocol/notification-receipts";
import { parseAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import type { DeliveredAgentToast } from "./viewed-agent-notifications.js";

const RoutingSchema = z.object({
  serverId: z.string().min(1).max(256),
  workspaceId: z.string().max(256).optional(),
  agentId: z.string().max(256).optional(),
  terminalId: z.string().max(256).optional(),
  notificationSequence: z.number().int().positive().optional(),
  attentionTimestamp: z.string().optional(),
});
const StoreSchema = z.object({
  shown: z.record(z.string(), RoutingSchema),
  pending: z.array(NotificationDismissalSchema),
  historyIdentities: z.record(z.string(), z.string()).optional(),
});

/** Opaque identity of an exact native record, never decoded as renderer authority.
 * Callers derive this from freshly enumerated history or their own live creation. */
export function notificationHistoryIdentifier(toast: DeliveredAgentToast): string | null {
  if (!toast.tag || (toast.namespace !== "current" && toast.namespace !== "legacy")) return null;
  return (
    "history:" +
    createHash("sha256")
      .update(JSON.stringify([toast.namespace, toast.group, toast.tag, toast.arguments]))
      .digest("hex")
  );
}

/** App-owned mapping and exact-dismiss outbox. Never infer a swipe from missing OS history. */
export class DesktopNotificationReceipts {
  private document: z.infer<typeof StoreSchema>;
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = path.join(directory, "notification-receipts.json");
    this.document = existsSync(this.file)
      ? StoreSchema.parse(JSON.parse(readFileSync(this.file, "utf8")))
      : { shown: {}, pending: [] };
  }

  /** Remember routing only, never titles, messages, credentials, or renderer-supplied paths. */
  shown(
    identifier: string,
    data: Record<string, unknown> | undefined,
    historyIdentity?: string,
  ): void {
    const parsed = RoutingSchema.safeParse(data);
    if (!parsed.success) return;
    const next = structuredClone(this.document);
    next.shown[identifier] = parsed.data;
    next.historyIdentities ??= {};
    if (historyIdentity) next.historyIdentities[identifier] = historyIdentity;
    else delete next.historyIdentities[identifier];
    this.persist(next);
  }

  /** Only a native explicit-dismiss callback may enter this durable outbox. */
  dismissed(identifier: string): boolean {
    const receipt = NotificationReceiptDataSchema.safeParse(this.document.shown[identifier]);
    if (!receipt.success) return false;
    const next = structuredClone(this.document);
    if (!next.pending.some((item) => item.id === identifier)) {
      next.pending.push({ id: identifier, data: receipt.data });
    }
    delete next.shown[identifier];
    if (next.historyIdentities) delete next.historyIdentities[identifier];
    this.persist(next);
    return true;
  }

  pending(): NotificationDismissal[] {
    return structuredClone(this.document.pending);
  }

  acknowledge(ids: string[]): void {
    const removed = new Set(ids);
    const next = structuredClone(this.document);
    next.pending = next.pending.filter((item) => !removed.has(item.id));
    this.persist(next);
  }

  forget(ids: string[]): void {
    const next = structuredClone(this.document);
    for (const id of ids) {
      delete next.shown[id];
      if (next.historyIdentities) delete next.historyIdentities[id];
    }
    this.persist(next);
  }

  /** Retire only the saved mapping bound to an actually removed native tuple.
   * A different group or launch sharing its tag must not erase live routing. */
  forgetHistory(toasts: DeliveredAgentToast[]): void {
    const ids = toasts.flatMap((toast) => {
      const identity = notificationHistoryIdentifier(toast);
      return toast.namespace === "current" &&
        identity !== null &&
        this.document.historyIdentities?.[toast.tag] === identity
        ? [toast.tag]
        : [];
    });
    if (ids.length > 0) this.forget(ids);
  }

  /** Resolve durable current entries, plus old fork-owned agent launches for startup capture. */
  history(
    toasts: DeliveredAgentToast[],
  ): Array<{ identifier: string; data: Record<string, unknown> }> {
    return toasts.flatMap((toast) => {
      const identifier = notificationHistoryIdentifier(toast);
      if (!identifier) return [];
      const saved =
        toast.namespace === "current" && this.document.historyIdentities?.[toast.tag] === identifier
          ? this.document.shown[toast.tag]
          : undefined;
      if (saved) return [{ identifier, data: saved }];
      const parameters = new URLSearchParams(toast.arguments);
      const embedded = parameters.get("paseoReceipt");
      if (embedded) {
        try {
          const parsed = NotificationReceiptDataSchema.safeParse(JSON.parse(embedded));
          if (parsed.success) return [{ identifier, data: parsed.data }];
        } catch {
          /* Invalid history metadata grants no matching authority. */
        }
      }
      const link = parameters.get("paseoAgent");
      const target = link ? parseAgentDeepLink(link) : null;
      return target
        ? [{ identifier, data: { serverId: target.serverId, agentId: target.agentId } }]
        : [];
    });
  }

  private persist(next: z.infer<typeof StoreSchema>): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp.${randomUUID()}`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
      this.document = next;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
