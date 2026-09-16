import type { API } from 'homebridge'

import { UniFiProtectCameraPlatform } from './platform.js'
import { PLATFORM_NAME } from './settings.js'

/**
 * Homebridge calls this once at startup to register the platform.
 */
export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, UniFiProtectCameraPlatform)
}
