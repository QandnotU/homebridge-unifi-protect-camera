import type { Camera } from 'unifi-protect'

import type { AccessUnit } from '../fmp4/demux.js'
import type { AvcConfig } from '../fmp4/avcc.js'
import type { ScopedLogger } from '../../core/logger.js'
import type { TrackInfo } from '../fmp4/init-segment.js'
import { applyTimestamps, splitAccessUnits, withParameterSets } from '../fmp4/demux.js'
import { readAvcConfig } from '../fmp4/avcc.js'
import { readTrackInfo } from '../fmp4/init-segment.js'

export interface VideoSourceOptions {
  readonly camera: Camera
  /** Protect channel index: 0 is High, 1 Medium, 2 Low on the cameras we have seen. */
  readonly channelId: number
  readonly log: ScopedLogger
  readonly signal: AbortSignal
  /** Nominal frame rate, used only to synthesise timing if the controller sends none. */
  readonly fps: number
}

/**
 * One camera channel, decoded from Protect's fMP4 into access units.
 *
 * Deliberately thin. The v5 client's livestream pool already shares one upstream session
 * between subscribers that asked for a byte-identical stream, so two HomeKit viewers on
 * the same channel cost one connection to the controller without any bookkeeping here.
 * What this adds is the decode: init segment to codec configuration, and media segments
 * to access units ready for packetization.
 */
export class VideoSource {
  readonly #config: AvcConfig
  readonly #track: TrackInfo
  readonly #subscription: AsyncIterable<{ type: string, mdat?: Buffer, timestamps?: number[] }>
  readonly #log: ScopedLogger
  readonly #fps: number

  private constructor(
    config: AvcConfig,
    track: TrackInfo,
    subscription: AsyncIterable<{ type: string, mdat?: Buffer, timestamps?: number[] }>,
    log: ScopedLogger,
    fps: number,
  ) {
    this.#config = config
    this.#track = track
    this.#subscription = subscription
    this.#log = log
    this.#fps = fps
  }

  /**
   * Open the channel and wait for its initialisation segment.
   *
   * Throws if the stream cannot be established or its init segment is unreadable — the
   * caller cannot do anything useful without the codec configuration, and failing here
   * gives a clear error instead of a stream that silently produces nothing.
   */
  static async open(options: VideoSourceOptions): Promise<VideoSource> {
    const subscription = options.camera.livestream({
      signal: options.signal,
      source: { channel: options.channelId, type: 'channel' },
      // Opting in to decode timestamps is what lets the demuxer skip moof/trun entirely.
      timestamps: true,
    })

    if (!await subscription.whenEstablished()) {
      throw new Error(`Protect did not establish a livestream on channel ${options.channelId.toString()}`)
    }

    const init = subscription.initSegment

    if (!init) {
      throw new Error('Protect established the livestream but sent no initialisation segment')
    }

    if (init.codec && !init.codec.toLowerCase().includes('avc')) {
      throw new Error(`stream is ${init.codec}, but the classic HomeKit path carries H.264 only`)
    }

    const config = readAvcConfig(init.data)

    if (!config) {
      throw new Error('initialisation segment carries no readable avcC configuration')
    }

    const track = readTrackInfo(init.data)

    if (!track) {
      throw new Error('initialisation segment carries no readable track information')
    }

    options.log.debug('Channel %s: %sx%s, timescale %s, %s SPS and %s PPS',
      options.channelId.toString(), track.width.toString(), track.height.toString(),
      track.timescale.toString(), config.sps.length.toString(), config.pps.length.toString())

    return new VideoSource(config, track, subscription, options.log, options.fps)
  }

  get config(): AvcConfig {
    return this.#config
  }

  get track(): TrackInfo {
    return this.#track
  }

  /**
   * Yield access units as they arrive.
   *
   * Keyframes are given the parameter sets a decoder needs, because Protect keeps SPS and
   * PPS in the init segment and a HomeKit client joining mid-stream never saw it.
   */
  async *accessUnits(): AsyncGenerator<AccessUnit> {
    // One frame's worth of ticks, used only when the controller sends no timestamps.
    const step = Math.max(1, Math.round(this.#track.timescale / Math.max(1, this.#fps)))

    let nextFallback = 0

    for await (const segment of this.#subscription) {
      if ((segment.type !== 'media') || !segment.mdat) {
        continue
      }

      const units = splitAccessUnits(segment.mdat, this.#config)

      if (units.length === 0) {
        continue
      }

      const timed = applyTimestamps(units, segment.timestamps, nextFallback, step)

      nextFallback = (timed.at(-1)?.timestamp ?? nextFallback) + step

      for (const unit of timed) {
        yield withParameterSets(unit, this.#config)
      }
    }

    this.#log.debug('Protect stream ended.')
  }
}
