import type { WorkspacePinScope } from "@getpaseo/protocol/messages";
import { registerForkCapability } from "./fork-capabilities.js";

// COMPAT(projectWorkspacePinning): added in v0.11.2, remove gate after 2027-02-11.
registerForkCapability("projectWorkspacePinning");

export type { WorkspacePinScope };

/** The registry pin fields one workspace.pin.set request writes. */
export interface WorkspacePinFields {
  pinnedAt: string | null;
  projectPinnedAt: string | null;
}

/**
 * Resolve the registry pin fields for a pin request.
 *
 * The scopes are exclusive: pinning in one scope clears the other, so one registry update
 * switches scope without ever exposing a workspace pinned in both places.
 *
 * @param scope where the pin applies; legacy requests without a scope are global.
 * @param pinnedAt the new pin timestamp, or null to unpin.
 */
export function resolveWorkspacePinFields(
  scope: WorkspacePinScope,
  pinnedAt: string | null,
): WorkspacePinFields {
  return {
    pinnedAt: scope === "global" ? pinnedAt : null,
    projectPinnedAt: scope === "project" ? pinnedAt : null,
  };
}
