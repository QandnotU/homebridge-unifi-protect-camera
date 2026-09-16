import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge'

import type { ResolvedConfig } from './types/config.js'
import type { ScopedLogger } from './core/logger.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'
import { createLogger } from './core/logger.js'
import { validateConfig } from './config.js'

/**
 * The plugin's Homebridge entry point.
 *
 * The platform owns configuration, the accessory cache and the process lifecycle, and
 * nothing else. Protect connectivity, HomeKit services and the video pipeline live in
 * their own modules and are driven from here — see ARCHITECTURE.md §5.1.
 */
export class UniFiProtectCameraPlatform implements DynamicPlatformPlugin {
  private readonly log: ScopedLogger
  private readonly api: API

  /** Aborted when Homebridge shuts down. Every long-lived task must observe this. */
  private readonly shutdown = new AbortController()

  /** Accessories Homebridge restored from disk, keyed by UUID. */
  public readonly cachedAccessories = new Map<string, PlatformAccessory>()

  constructor(log: Logging, platformConfig: PlatformConfig, api: API) {
    this.log = createLogger(log)
    this.api = api

    const { config, issues } = validateConfig(platformConfig)

    for (const issue of issues) {
      if (issue.fatal) {
        this.log.error(issue.message)
      } else {
        this.log.warn(issue.message)
      }
    }

    if (!config) {
      this.log.error('Plugin is idle until the configuration is corrected.')

      return
    }

    // Cached accessories are restored before this fires, so discovery can safely reconcile
    // against them.
    this.api.on('didFinishLaunching', () => {
      void this.start(config)
    })

    this.api.on('shutdown', () => {
      this.stop()
    })
  }

  /**
   * Called by Homebridge once per accessory restored from disk, before
   * `didFinishLaunching`. We only record them here; reconciliation happens during
   * discovery, once we know what the controller actually has.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restoring cached accessory: %s', accessory.displayName)
    this.cachedAccessories.set(accessory.UUID, accessory)
  }

  /**
   * Drop accessories that no longer exist on any controller, so a camera removed from
   * Protect does not linger in the Home app as an unresponsive tile.
   */
  public removeCachedAccessories(accessories: readonly PlatformAccessory[]): void {
    if (accessories.length === 0) {
      return
    }

    for (const accessory of accessories) {
      this.log.info('Removing accessory no longer present in Protect: %s', accessory.displayName)
      this.cachedAccessories.delete(accessory.UUID)
    }

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [...accessories])
  }

  private async start(config: ResolvedConfig): Promise<void> {
    const count = config.controllers.length

    this.log.info('Starting with %s controller%s, %s cached accessor%s.',
      count.toString(), count === 1 ? '' : 's',
      this.cachedAccessories.size.toString(), this.cachedAccessories.size === 1 ? 'y' : 'ies')

    if (config.options.maximumQuality) {
      this.log.info('Maximum HomeKit Quality is enabled — image quality is preferred over CPU and bandwidth.')
    }

    for (const controller of config.controllers) {
      this.log.debug('Configured controller: %s (%s), TLS verification %s',
        controller.name, controller.host, controller.verifyTls ? 'on' : 'off')
    }

    // Phase 1 attaches here: connect each controller with ProtectClient.connect(), discover
    // cameras, reconcile against `cachedAccessories`, and subscribe to the realtime event
    // stream. Everything it starts must observe `this.shutdown.signal`.
    await Promise.resolve()

    this.log.warn('Protect connectivity is not implemented yet — no cameras will appear. (Phase 1)')
  }

  private stop(): void {
    this.log.debug('Shutting down.')
    this.shutdown.abort()
  }
}
