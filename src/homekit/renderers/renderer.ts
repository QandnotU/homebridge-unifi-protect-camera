import type { PlatformAccessory } from 'homebridge'

import type { CameraCapabilities } from '../../protect/capabilities.js'

/**
 * A renderer publishes a camera's capabilities through one HomeKit camera protocol.
 *
 * There is only one implementation today. The seam exists because Apple's iOS 27 secure
 * video path is a different set of services carrying the *same* tier model — so adding it
 * should mean writing a second renderer over an unchanged capability model, not
 * restructuring the plugin. ARCHITECTURE.md §5.1 and §5.5.
 *
 * Secure video services and a classic `CameraRTPStreamManagement` cannot coexist on one
 * accessory, so exactly one renderer is ever attached.
 */
export interface CameraRenderer {
  /** Human-readable name for logs. */
  readonly name: string

  /** Attach the HomeKit surface to the accessory. */
  attach(accessory: PlatformAccessory, capabilities: CameraCapabilities): void

  /** Apply a refreshed capability model, if the renderer can do so without re-pairing. */
  update(capabilities: CameraCapabilities): void

  shutdown(): Promise<void>
}
