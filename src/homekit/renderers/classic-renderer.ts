import type { API, PlatformAccessory, Resolution } from 'homebridge'
import type { Camera } from 'unifi-protect'

import type { CameraCapabilities, StreamTier } from '../../protect/capabilities.js'
import type { CameraRenderer } from './renderer.js'
import type { Lifecycle } from '../../core/lifecycle.js'
import type { ScopedLogger } from '../../core/logger.js'
import { H264_LEVEL, H264_PROFILE, MAX_ADVERTISABLE_LEVEL, SRTP_CRYPTO_SUITE } from '../hap-constants.js'
import { ProtectStreamingDelegate } from '../streaming-delegate.js'
import { hasConformingFrameRate } from '../../protect/capabilities.js'
import { minimumLevelFor } from '../../media/fmp4/avcc.js'

export interface ClassicRendererOptions {
  readonly api: API
  readonly camera: Camera
  readonly capabilities: () => CameraCapabilities
  readonly lifecycle: Lifecycle
  readonly log: ScopedLogger
  readonly maximumQuality: boolean
  readonly verboseDiagnostics: boolean
}

/**
 * Why a tier cannot be advertised on the classic HomeKit path, or null if it can.
 *
 * Both reasons are honest refusals rather than workarounds. Advertising a frame rate we
 * do not send, or a resolution whose H.264 level we cannot declare, produces a camera
 * that negotiates and then fails — which is far harder to diagnose than one that never
 * offered the option.
 */
export function rejectionReason(tier: StreamTier): string | null {
  if (!hasConformingFrameRate(tier)) {
    return `${tier.fps.toString()} fps is not one HomeKit negotiates`
  }

  const required = minimumLevelFor(tier.width, tier.height)

  if ((required === null) || (required > MAX_ADVERTISABLE_LEVEL)) {
    return `needs H.264 level ${required === null ? 'beyond any defined level' : (required / 10).toFixed(1)}, ` +
      'above the 4.0 ceiling HAP-NodeJS can advertise'
  }

  return null
}

/** Build the resolution list from the tiers we can actually deliver, largest first. */
export function advertisableResolutions(capabilities: CameraCapabilities): Resolution[] {
  return capabilities.tiers
    .filter(tier => tier.enabled && (rejectionReason(tier) === null))
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))
    .map(tier => [tier.width, tier.height, tier.fps] as Resolution)
}

/**
 * Publishes a camera through HAP's classic `CameraController`.
 *
 * The advertised resolution list is exactly what the camera can deliver natively — no
 * synthetic entries, no normalised frame rates. A HomeKit request therefore always maps
 * onto a real Protect channel, which is what keeps the streaming path a passthrough.
 */
export class ClassicRenderer implements CameraRenderer {
  readonly name = 'classic'

  readonly #options: ClassicRendererOptions
  readonly #log: ScopedLogger
  #delegate: ProtectStreamingDelegate | null = null

  constructor(options: ClassicRendererOptions) {
    this.#options = options
    this.#log = options.log
  }

  attach(accessory: PlatformAccessory, capabilities: CameraCapabilities): void {
    const resolutions = advertisableResolutions(capabilities)

    for (const tier of capabilities.tiers) {
      const reason = rejectionReason(tier)

      if (reason) {
        this.#log.warn('Not advertising the %s channel (%sx%s@%sfps): %s.',
          tier.channelName, tier.width.toString(), tier.height.toString(), tier.fps.toString(), reason)
      }
    }

    if (resolutions.length === 0) {
      this.#log.error('No channel can be advertised to HomeKit, so live video is unavailable for this camera.')

      return
    }

    this.#log.info('Advertising %s: %s', resolutions.length === 1 ? 'one resolution' : `${resolutions.length.toString()} resolutions`,
      resolutions.map(([width, height, fps]) => `${width.toString()}x${height.toString()}@${fps.toString()}`).join(', '))

    const delegate = new ProtectStreamingDelegate({
      camera: this.#options.camera,
      capabilities: this.#options.capabilities,
      lifecycle: this.#options.lifecycle,
      log: this.#log,
      maximumQuality: this.#options.maximumQuality,
      verboseDiagnostics: this.#options.verboseDiagnostics,
    })

    this.#delegate = delegate

    const controller = new this.#options.api.hap.CameraController({
      cameraStreamCount: 2,
      delegate,
      streamingOptions: {
        supportedCryptoSuites: [SRTP_CRYPTO_SUITE.AES_CM_128_HMAC_SHA1_80],
        video: {
          codec: {
            // Every profile the camera might emit. The camera's actual profile comes from
            // its avcC and is reported per session in the diagnostics.
            levels: [H264_LEVEL.LEVEL3_1, H264_LEVEL.LEVEL3_2, H264_LEVEL.LEVEL4_0],
            profiles: [H264_PROFILE.BASELINE, H264_PROFILE.MAIN, H264_PROFILE.HIGH],
          },
          resolutions,
        },
      },
    })

    accessory.configureController(controller)
  }

  update(capabilities: CameraCapabilities): void {
    // The advertised configuration is fixed at pairing time; HomeKit does not re-read it.
    // A channel change therefore only matters at the next restart, which we say plainly
    // rather than pretending to apply it.
    const resolutions = advertisableResolutions(capabilities)

    this.#log.debug('Capabilities refreshed; %s advertisable resolution(s) at next restart.', resolutions.length.toString())
  }

  async shutdown(): Promise<void> {
    await this.#delegate?.shutdown()
  }
}
