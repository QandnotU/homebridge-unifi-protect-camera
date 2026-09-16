import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge'

import type { CameraAccessoryContext } from './accessories/camera-accessory.js'
import type { CameraCapabilities } from './protect/capabilities.js'
import type { CameraEvent } from './protect/events.js'
import type { ResolvedConfig, ResolvedControllerConfig } from './types/config.js'
import type { ScopedLogger } from './core/logger.js'
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js'
import { CameraAccessory } from './accessories/camera-accessory.js'
import { Lifecycle } from './core/lifecycle.js'
import { ProtectController } from './protect/controller.js'
import { createLogger } from './core/logger.js'
import { validateConfig } from './config.js'

/**
 * The plugin's Homebridge entry point.
 *
 * The platform owns configuration, the accessory set and the process lifecycle, and
 * nothing else. Protect connectivity lives in {@link ProtectController}, HomeKit services
 * in {@link CameraAccessory}, and the video pipeline in its own modules — see
 * ARCHITECTURE.md §5.1.
 */
export class UniFiProtectCameraPlatform implements DynamicPlatformPlugin {
  private readonly log: ScopedLogger
  private readonly api: API

  /** Aborted when Homebridge shuts down. Every long-lived task descends from this. */
  private readonly lifecycle = new Lifecycle()

  /** Accessories Homebridge restored from disk, keyed by UUID. Drained as they are adopted. */
  public readonly cachedAccessories = new Map<string, PlatformAccessory<CameraAccessoryContext>>()

  /** Live accessories, keyed by HomeKit UUID. */
  private readonly cameras = new Map<string, CameraAccessory>()

  /** Camera id to UUID, so realtime events reach the right accessory without a scan. */
  private readonly cameraIndex = new Map<string, string>()

  private readonly controllers: ProtectController[] = []

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

    // Cached accessories are restored before this fires, so discovery can reconcile
    // against them.
    this.api.on('didFinishLaunching', () => {
      this.start(config)
    })

    this.api.on('shutdown', () => {
      void this.stop()
    })
  }

  /**
   * Called by Homebridge once per accessory restored from disk, before
   * `didFinishLaunching`. We only record them here; adoption happens once a controller
   * tells us what actually exists.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Restoring cached accessory: %s', accessory.displayName)
    this.cachedAccessories.set(accessory.UUID, accessory as PlatformAccessory<CameraAccessoryContext>)
  }

  private start(config: ResolvedConfig): void {
    const count = config.controllers.length

    this.log.info('Starting with %s controller%s, %s cached accessor%s.',
      count.toString(), count === 1 ? '' : 's',
      this.cachedAccessories.size.toString(), this.cachedAccessories.size === 1 ? 'y' : 'ies')

    if (config.options.maximumQuality) {
      this.log.info('Maximum HomeKit Quality is enabled — image quality is preferred over CPU and bandwidth.')
    }

    for (const controllerConfig of config.controllers) {
      const controller = new ProtectController(controllerConfig, this.log, this.lifecycle)

      this.controllers.push(controller)

      controller.start({
        onCameras: cameras => { this.syncCameras(controllerConfig, cameras) },
        onEvent: event => { this.routeEvent(event) },
        onReachability: reachable => { this.setReachability(controllerConfig, reachable) },
      })
    }
  }

  /**
   * Reconcile one controller's camera set against what HomeKit currently has: adopt cached
   * accessories, register new ones, prune the departed.
   */
  private syncCameras(controllerConfig: ResolvedControllerConfig, cameras: readonly CameraCapabilities[]): void {
    const log = this.log.scope(controllerConfig.name)
    const seen = new Set<string>()

    for (const capabilities of cameras) {
      const uuid = this.api.hap.uuid.generate(capabilities.mac)

      seen.add(uuid)

      const existing = this.cameras.get(uuid)

      if (existing) {
        existing.update(capabilities)
        continue
      }

      const cached = this.cachedAccessories.get(uuid)

      if (cached) {
        this.cachedAccessories.delete(uuid)
        cached.displayName = capabilities.name
        log.info('Restored %s from cache.', capabilities.name)

        const camera = new CameraAccessory(this.api, log, cached, capabilities, controllerConfig.host)

        this.cameras.set(uuid, camera)
        this.cameraIndex.set(capabilities.id, uuid)
        this.api.updatePlatformAccessories([cached])
        continue
      }

      const accessory = new this.api.platformAccessory<CameraAccessoryContext>(capabilities.name, uuid)
      const camera = new CameraAccessory(this.api, log, accessory, capabilities, controllerConfig.host)

      this.cameras.set(uuid, camera)
      this.cameraIndex.set(capabilities.id, uuid)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      log.success('Added %s.', capabilities.name)
    }

    this.pruneDeparted(controllerConfig, seen, cameras.length, log)
  }

  /**
   * Remove accessories this controller no longer reports.
   *
   * An empty camera list is treated as suspect rather than authoritative: a permissions
   * change or a half-initialised controller can report zero cameras, and acting on that
   * would unpair every camera in the Home app — losing the user's automations, rooms and
   * recordings. We would rather leave a stale tile than destroy a pairing.
   */
  private pruneDeparted(
    controllerConfig: ResolvedControllerConfig,
    seen: ReadonlySet<string>,
    reportedCount: number,
    log: ScopedLogger,
  ): void {
    const ownedByThisController = (context: CameraAccessoryContext): boolean =>
      context.controllerHost === controllerConfig.host

    if (reportedCount === 0) {
      const owned = [...this.cameras.values()].filter(camera => ownedByThisController(camera.accessory.context))

      if (owned.length > 0) {
        log.warn('Reported no cameras while %s %s still paired. Keeping them — check the account\'s camera permissions.',
          owned.length.toString(), owned.length === 1 ? 'is' : 'are')
      }

      return
    }

    const stale: PlatformAccessory<CameraAccessoryContext>[] = []

    for (const [uuid, camera] of this.cameras) {
      if (seen.has(uuid) || !ownedByThisController(camera.accessory.context)) {
        continue
      }

      camera.dispose()
      this.cameras.delete(uuid)
      this.cameraIndex.delete(camera.cameraId)
      stale.push(camera.accessory)
    }

    // Cached accessories never adopted by this controller are also gone from Protect.
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (seen.has(uuid) || !ownedByThisController(accessory.context)) {
        continue
      }

      this.cachedAccessories.delete(uuid)
      stale.push(accessory)
    }

    if (stale.length === 0) {
      return
    }

    for (const accessory of stale) {
      log.info('Removing %s — no longer present in Protect.', accessory.displayName)
    }

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale)
  }

  private routeEvent(event: CameraEvent): void {
    const uuid = this.cameraIndex.get(event.cameraId)

    if (!uuid) {
      return
    }

    this.cameras.get(uuid)?.handleEvent(event)
  }

  private setReachability(controllerConfig: ResolvedControllerConfig, reachable: boolean): void {
    for (const camera of this.cameras.values()) {
      if (camera.accessory.context.controllerHost === controllerConfig.host) {
        camera.setReachable(reachable)
      }
    }
  }

  private async stop(): Promise<void> {
    this.log.debug('Shutting down.')

    for (const camera of this.cameras.values()) {
      camera.dispose()
    }

    await Promise.all(this.controllers.map(controller => controller.dispose()))
    await this.lifecycle.dispose()
  }
}
