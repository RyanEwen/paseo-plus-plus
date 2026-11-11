import path from "node:path";
import { ATTACHMENT_LIST_PAGE_MAX, type AttachmentReference } from "@getpaseo/protocol/attachments";
import { AttachmentStoreError, hasErrnoCode, type AttachmentFileSystem } from "./io.js";
import type { AttachmentLimits } from "./limits.js";

interface OwnerUsage {
  bytes: number;
  references: number;
  hashes: Set<string>;
}

/** Files one publication linked, so a clean commit can update accounting without a rescan. */
export interface PublicationEffects {
  blobBytes?: number;
  reference?: AttachmentReference;
  completed: boolean;
}

/**
 * Order references by ID. IDs are time-ordered, and code-unit order matches the `after`
 * cursor's `>` comparison, which locale-aware comparison does not guarantee.
 */
function compareReferenceIds(a: AttachmentReference, b: AttachmentReference): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * In-memory charges for everything under the attachment root.
 *
 * Every file costs one `entryCharge` of metadata. Blob and staging files also charge their
 * size; reference files charge only their entry. Owners are charged once per distinct content
 * hash, so a deduplicated capture costs a reference but no new bytes.
 */
export class AttachmentAccounting {
  private references = new Map<string, AttachmentReference>();
  private owners = new Map<string, OwnerUsage>();
  private chargedBytes = 0;
  private metadataBytes = 0;
  private blobFiles = 0;
  private referenceFiles = 0;

  constructor(private readonly limits: AttachmentLimits) {}

  /**
   * Rebuild every charge by walking the root. Returns whether anything could not be
   * accounted for exactly: a link, a non-file artifact or an unreadable reference record.
   */
  async scan(
    io: AttachmentFileSystem,
    root: string,
    readReference: (id: string) => Promise<AttachmentReference>,
  ): Promise<{ uncertain: boolean }> {
    const next = new AttachmentAccounting(this.limits);
    const referencesDirectory = path.join(root, "references");
    const writer = path.join(root, "writer");
    let entries = 0;
    let uncertain = false;

    const walk = async (directory: string): Promise<void> => {
      let stream;
      try {
        stream = await io.opendir(directory);
      } catch (error) {
        if (hasErrnoCode(error, "ENOENT")) return;
        throw error;
      }
      for await (const entry of stream) {
        if (++entries > this.limits.scanEntries)
          throw new AttachmentStoreError("Attachment accounting scan limit exceeded.");
        const file = path.join(directory, entry.name);
        const info = await io.lstat(file);
        if (info.isSymbolicLink()) {
          uncertain = true;
          continue;
        }
        if (info.isDirectory()) {
          await walk(file);
          continue;
        }

        next.metadataBytes += this.limits.entryCharge;
        if (directory === referencesDirectory) {
          next.referenceFiles++;
          try {
            if (!/^att_[0-9a-f-]{36}\.json$/.test(entry.name))
              throw new AttachmentStoreError("Unknown reference entry.");
            next.addReference(await readReference(entry.name.slice(0, -5)));
          } catch {
            uncertain = true;
          }
        } else if (file !== writer) {
          next.chargedBytes += info.size;
          next.blobFiles++;
          if (!info.isFile()) uncertain = true;
        }
      }
    };
    await walk(root);

    this.references = next.references;
    this.owners = next.owners;
    this.chargedBytes = next.chargedBytes + next.metadataBytes;
    this.metadataBytes = next.metadataBytes;
    this.blobFiles = next.blobFiles;
    this.referenceFiles = next.referenceFiles;
    return { uncertain };
  }

  /** Charge a completed publication exactly as a rescan of its new files would. */
  recordPublication(effects: PublicationEffects): void {
    const entry = this.limits.entryCharge;
    if (effects.blobBytes !== undefined) {
      this.blobFiles++;
      this.metadataBytes += entry;
      this.chargedBytes += effects.blobBytes + entry;
    }
    if (!effects.reference) return;
    this.referenceFiles++;
    this.metadataBytes += entry;
    this.chargedBytes += entry;
    this.addReference(effects.reference);
  }

  /**
   * Whether one more original of up to `maxImageBytes` for `agentId` would exceed any byte,
   * count or metadata quota. A capture reserves its worst case: one blob and one reference.
   */
  exceedsQuota(agentId: string, maxImageBytes: number): boolean {
    const usage = this.owners.get(agentId);
    const entry = this.limits.entryCharge;
    const overBytes =
      this.chargedBytes + maxImageBytes + 2 * entry > this.limits.globalBytes ||
      (usage?.bytes ?? 0) + maxImageBytes > this.limits.ownerBytes;
    const overCount =
      this.referenceFiles + 1 > this.limits.globalReferences ||
      (usage?.references ?? 0) + 1 > this.limits.ownerReferences ||
      this.blobFiles + 1 > this.limits.blobFiles;
    const overMetadata = this.metadataBytes + 2 * entry > this.limits.metadataBytes;
    return overBytes || overCount || overMetadata;
  }

  /** An existing reference this owner already holds for identical content and type. */
  findOwnedCopy(
    agentId: string,
    sha256: string,
    mimeType: string,
  ): AttachmentReference | undefined {
    return [...this.references.values()].find(
      (reference) =>
        reference.agentId === agentId &&
        reference.sha256 === sha256 &&
        reference.mimeType === mimeType,
    );
  }

  /** One page of an owner's references in ID order, after the `after` cursor. */
  list(
    agentId: string,
    after: string | undefined,
    limit: number,
  ): { references: AttachmentReference[]; next: string | null } {
    const references = [...this.references.values()]
      .filter((reference) => reference.agentId === agentId && (!after || reference.id > after))
      .sort(compareReferenceIds);
    // Callers pass a protocol-validated limit; clamp only to keep a direct call bounded.
    const page = references.slice(0, Math.min(ATTACHMENT_LIST_PAGE_MAX, Math.max(1, limit)));
    const next = references.length > page.length ? page[page.length - 1].id : null;
    return { references: page, next };
  }

  private addReference(reference: AttachmentReference): void {
    this.references.set(reference.id, reference);
    const usage = this.owners.get(reference.agentId) ?? {
      bytes: 0,
      references: 0,
      hashes: new Set<string>(),
    };
    usage.references++;
    if (!usage.hashes.has(reference.sha256)) {
      usage.bytes += reference.byteLength;
      usage.hashes.add(reference.sha256);
    }
    this.owners.set(reference.agentId, usage);
  }
}
