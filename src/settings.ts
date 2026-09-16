/**
 * The platform name users put in the `platform` field of their Homebridge `config.json`.
 *
 * This is effectively permanent. Homebridge keys its cached-accessory store on
 * (plugin name, platform name), so changing either orphans every paired accessory and
 * forces users to re-add each camera to the Home app by hand.
 */
export const PLATFORM_NAME = 'UniFiProtectCamera'

/**
 * Must match the `name` field in package.json — Homebridge discovers, installs and
 * identifies plugins by their npm package name. See the note on {@link PLATFORM_NAME}
 * about why this is not safe to change later.
 */
export const PLUGIN_NAME = 'homebridge-unifi-protect-camera'

/**
 * Default for {@link ControllerConfig.verifyTls}.
 *
 * UniFi Protect controllers ship with a self-signed certificate, so strict verification
 * fails on a stock install. We default to off and let operators with a proper
 * certificate chain opt in.
 */
export const DEFAULT_VERIFY_TLS = false
