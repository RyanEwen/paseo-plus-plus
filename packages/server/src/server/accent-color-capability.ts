import { registerForkCapability } from "./fork-capabilities.js";

/**
 * The daemon stores the Paseo++ accent choice as a plain app setting (accentColor is in the shared
 * synced key registry), so advertising the capability is all this layer adds on the server. Clients
 * gate the accent picker and its publication on it for the selected settings host.
 */
// COMPAT(appSettingsAccentColor): added in v0.11.2, remove gate after 2027-10-14.
registerForkCapability("appSettingsAccentColor");
