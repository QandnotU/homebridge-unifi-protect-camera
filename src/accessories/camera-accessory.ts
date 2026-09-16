import type { API, PlatformAccessory, Service } from 'homebridge'

import type { CameraCapabilities } from '../protect/capabilities.js'
import type { CameraRenderer } from '../homekit/renderers/renderer.js'
import type { CameraEvent } from '../protect/events.js'
import type { ScopedLogger } from '../core/logger.js'
import { conformingAlternatives, describeTier, hasConformingFrameRate, joinOr } from '../protect/capabilities.js'

/**
 * How long a motion event stays asserted in HomeKit.
 *
 * Protect reports motion as a discrete event rather than a level, so the sensor has to be
 * released on a timer. Four seconds is long enough for the Home app to show the event and
 * for automations to fire, short enough that consecutive motion reads as separate events.
 */
const MOTION_HOLD_MS = 4_000

/** Bump when the shape of {@link CameraAccessoryContext} changes incompatibly. */
export const CONTEXT_SCHEMA_VERSION = 1

export interface CameraAccessoryContext extends Record<string, unknown> {
  cameraId: string
  controllerHost: string
  mac: string
  schemaVersion: number
}

/**
 * One Protect camera as a HomeKit accessory.
 *
 * It owns identity, motion and reachability, and delegates the entire camera surface to a
 * {@link CameraRenderer}. Keeping video behind that seam is what stops this class growing
 * into the monolithic camera object the architecture warns against — and is what lets a
 * future secure-video renderer be additive.
 */
export class CameraAccessory {
  readonly #api: API
  readonly #log: ScopedLogger
  readonly #accessory: PlatformAccessory<CameraAccessoryContext>

  readonly #renderer: CameraRenderer | null

  #capabilities: CameraCapabilities
  #motionTimer: NodeJS.Timeout | null = null
  #reachable = true

  constructor(
    api: API,
    log: ScopedLogger,
    accessory: PlatformAccessory<CameraAccessoryContext>,
    capabilities: CameraCapabilities,
    controllerHost: string,
    renderer: CameraRenderer | null = null,
  ) {
    this.#api = api
    this.#log = log.scope(capabilities.name)
    this.#accessory = accessory
    this.#capabilities = capabilities

    accessory.context.cameraId = capabilities.id
    accessory.context.controllerHost = controllerHost
    accessory.context.mac = capabilities.mac
    accessory.context.schemaVersion = CONTEXT_SCHEMA_VERSION

    this.#renderer = renderer

    this.#configureInformation()
    this.#configureMotion()
    this.#reportCapabilities()

    // The renderer attaches the HomeKit camera surface. Exactly one is ever attached: the
    // classic and secure-video service sets cannot coexist on one accessory.
    renderer?.attach(accessory, capabilities)
  }

  get cameraId(): string {
    return this.#capabilities.id
  }

  get accessory(): PlatformAccessory<CameraAccessoryContext> {
    return this.#accessory
  }

  /** The current capability model. Read by the streaming delegate at session start. */
  get capabilities(): CameraCapabilities {
    return this.#capabilities
  }

  #configureInformation(): void {
    const { Characteristic, Service } = this.#api.hap
    const info = this.#accessory.getService(Service.AccessoryInformation)
      ?? this.#accessory.addService(Service.AccessoryInformation)

    info
      .setCharacteristic(Characteristic.Manufacturer, 'Ubiquiti')
      .setCharacteristic(Characteristic.Model, this.#capabilities.model)
      .setCharacteristic(Characteristic.SerialNumber, this.#capabilities.mac)
      .setCharacteristic(Characteristic.FirmwareRevision, this.#capabilities.firmware ?? 'unknown')
  }

  #motionService(): Service {
    const { Service } = this.#api.hap

    return this.#accessory.getService(Service.MotionSensor)
      ?? this.#accessory.addService(Service.MotionSensor, this.#capabilities.name)
  }

  #configureMotion(): void {
    const { Characteristic } = this.#api.hap
    const service = this.#motionService()

    // Start released: a cached accessory must never come back asserting stale motion.
    service.updateCharacteristic(Characteristic.MotionDetected, false)
    service.updateCharacteristic(Characteristic.StatusActive, this.#reachable)
  }

  /**
   * Log what we found, including anything that will constrain HomeKit later. This is the
   * first half of the diagnostics story — the per-session stream record is the other.
   */
  #reportCapabilities(): void {
    const caps = this.#capabilities

    this.#log.info('%s — %s, %s%s', caps.model, caps.codec.toUpperCase(),
      caps.supportsHevc ? 'HEVC capable' : 'H.264 only',
      caps.hasMic ? ', microphone' : ', no microphone')

    for (const tier of caps.tiers) {
      this.#log.info('  %s: %s', tier.quality, describeTier(tier))
    }

    for (const tier of caps.tiers) {
      if (hasConformingFrameRate(tier)) {
        continue
      }

      const alternatives = conformingAlternatives(tier)

      this.#log.warn('  %s channel runs at %s fps, which HomeKit does not negotiate (it accepts 15, 24 or 30).%s',
        tier.channelName, tier.fps.toString(),
        alternatives.length > 0
          ? ` Set it to ${joinOr(alternatives)} fps in Protect to use this tier.`
          : ' This channel cannot be advertised.')
    }
  }

  /** Apply a refreshed capability model — name changes, firmware updates, channel edits. */
  update(capabilities: CameraCapabilities): void {
    const previous = this.#capabilities

    this.#capabilities = capabilities

    if (previous.name !== capabilities.name) {
      this.#log.info('Renamed to %s.', capabilities.name)
    }

    if (previous.firmware !== capabilities.firmware) {
      this.#log.info('Firmware is now %s.', capabilities.firmware ?? 'unknown')
    }

    // Re-publishes name, model and firmware onto the AccessoryInformation service.
    this.#configureInformation()

    if (JSON.stringify(previous.tiers) !== JSON.stringify(capabilities.tiers)) {
      this.#log.info('Stream configuration changed.')
      this.#reportCapabilities()
    }

    this.#renderer?.update(capabilities)
  }

  /**
   * Reflect controller reachability. `StatusActive` false is what stops the Home app from
   * showing a camera as available when we know it is not.
   */
  setReachable(reachable: boolean): void {
    if (this.#reachable === reachable) {
      return
    }

    this.#reachable = reachable
    this.#motionService().updateCharacteristic(this.#api.hap.Characteristic.StatusActive, reachable)

    if (!reachable) {
      this.#releaseMotion()
    }
  }

  handleEvent(event: CameraEvent): void {
    switch (event.kind) {
      case 'motion':
        this.#assertMotion('motion')
        break

      case 'smartDetect':
        // Protect opens a smart detection before it has classified the object, so the
        // first packet often carries an empty `objectTypes`. Motion is still real — we
        // assert it and say the classification is pending rather than inventing one.
        this.#assertMotion(event.objectTypes.length > 0
          ? `smart detection: ${joinOr(event.objectTypes)}`
          : 'smart detection (object not yet classified)')
        break

      case 'doorbellRing':
        // Doorbells arrive in a later phase; ignore rather than mis-signal motion.
        this.#log.debug('Doorbell ring ignored — doorbell support is not implemented yet.')
        break

      default:
        break
    }
  }

  #assertMotion(reason: string): void {
    if (!this.#reachable) {
      return
    }

    const service = this.#motionService()

    if (!this.#motionTimer) {
      this.#log.debug('Motion: %s', reason)
      service.updateCharacteristic(this.#api.hap.Characteristic.MotionDetected, true)
    }

    // Re-arm on every event so sustained activity holds the sensor rather than flapping.
    if (this.#motionTimer) {
      clearTimeout(this.#motionTimer)
    }

    this.#motionTimer = setTimeout(() => {
      this.#motionTimer = null
      this.#releaseMotion()
    }, MOTION_HOLD_MS)
  }

  #releaseMotion(): void {
    if (this.#motionTimer) {
      clearTimeout(this.#motionTimer)
      this.#motionTimer = null
    }

    this.#motionService().updateCharacteristic(this.#api.hap.Characteristic.MotionDetected, false)
  }

  async dispose(): Promise<void> {
    this.#releaseMotion()
    await this.#renderer?.shutdown()
  }
}
