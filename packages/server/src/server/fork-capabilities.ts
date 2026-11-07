import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";

/** A server_info feature flag name declared by the shared protocol schema. */
export type ForkCapability = keyof NonNullable<ServerInfoStatusPayload["features"]>;

const registered = new Set<ForkCapability>();

/**
 * Advertise a fork feature flag in server_info.features.
 *
 * Call it once at module load from the module that registers the feature's handlers, so a
 * daemon built without that feature layer never claims the capability. Registering the same
 * flag again has no effect.
 */
export function registerForkCapability(name: ForkCapability): void {
  registered.add(name);
}

/** Registered flags as the `true` entries spread into server_info.features. */
export function forkCapabilities(): Partial<Record<ForkCapability, true>> {
  return Object.fromEntries([...registered].map((name) => [name, true]));
}
