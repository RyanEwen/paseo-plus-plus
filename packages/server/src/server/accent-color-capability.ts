import { registerForkCapability } from "./fork-capabilities.js";

/**
 * Advertise the Paseo++ accent preference. The daemon stores accentColor as a plain app setting
 * (it is in the shared synced key registry), so the capability is all this layer adds on the
 * server. Clients gate the accent picker and its publication on it for the selected settings
 * host. Safe to call more than once.
 */
export function registerAccentColorCapability(): void {
  // COMPAT(appSettingsAccentColor): added in v0.11.2, remove gate after 2027-10-14.
  registerForkCapability("appSettingsAccentColor");
}
