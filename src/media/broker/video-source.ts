import type { Camera } from 'unifi-protect'

import type { AccessUnit } from '../fmp4/demux.js'
import type { AvcConfig } from '../fmp4/avcc.js'
import type { ScopedLogger } from '../../core/logger.js'
import type { TrackInfo } from '../fmp4/init-segment.js'
import { applyTimestamps, splitAccessUnits, withParameterSets } from '../fmp4/demux.js'
import { readAvcConfig } from '../fmp4/avcc.js'
import { iterateBoxes } from '../fmp4/boxes.js'
import { parseMoof, readVideoTrackId } from '../fmp4/moof.js'
import { readTrackInfo } from '../fmp4/init-segment.js'

/**
 * The video samples of a media segment, and nothing else.
 *
 * Two traps here, both found by probing a live controller rather than by reading types:
 *
 * `segment.mdat` is only the mdat *box header* — the library assembles the segment as
 * `[moof][mdat header][video][audio]` and slices `mdat` from the header frames alone, so
 * the samples live in `segment.data`.
 *
 * And that `mdat` carries AAC as well as H.264. Walking the whole payload by NAL length
 * prefixes reads audio as though it were video: it yields a spurious extra picture, which
 * makes the access-unit count disagree with the controller's timestamps and silently
 * drops the stream onto synthesised timing. So the video byte range comes from the
 * `trun`, which is the only thing that actually knows where video ends.
 */
export function videoPayload(segment: { data?: Buffer, moof?: Buffer }, videoTrackId: number | null): Buffer | null {
  const data = segment.data

  if (!data) {
    return null
  }

  if (videoTrackId !== null) {
    const runs = parseMoof(data)
    const video = runs.find(run => run.trackId === videoTrackId)

    if (video && (video.totalBytes > 0)) {
      // `data_offset` is relative to the start of the moof box, which is the start of the
      // segment here.
      const start = video.dataOffset
      const end = start + video.totalBytes

      if ((start >= 0) && (end <= data.length)) {
        return data.subarray(start, end)
      }
    }
  }

  // No usable sample table: fall back to the whole mdat body. The NAL walk will stop when
  // it reaches audio, so this still yields the pictures — just with the timestamp
  // mismatch described above. A degraded stream beats no stream.
  for (const box of iterateBoxes(data)) {
    if (box.type === 'mdat') {
      return box.body
    }
  }

  return null
}

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
  readonly #subscription: AsyncIterable<{ type: string, data?: Buffer, mdat?: Buffer, moof?: Buffer, timestamps?: number[] }>
  readonly #log: ScopedLogger
  readonly #fps: number
  readonly #videoTrackId: number | null

  private constructor(
    config: AvcConfig,
    track: TrackInfo,
    subscription: AsyncIterable<{ type: string, data?: Buffer, mdat?: Buffer, moof?: Buffer, timestamps?: number[] }>,
    log: ScopedLogger,
    fps: number,
    videoTrackId: number | null,
  ) {
    this.#config = config
    this.#track = track
    this.#subscription = subscription
    this.#log = log
    this.#fps = fps
    this.#videoTrackId = videoTrackId
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
      // Per-picture decode timestamps from the controller. Measured against a live
      // stream these match the access-unit count exactly, so the stream runs on the
      // camera's own clock rather than a synthesised one.
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

    const videoTrackId = readVideoTrackId(init.data)

    if (videoTrackId === null) {
      options.log.warn('Could not identify the video track; audio may be misread as video.')
    }

    return new VideoSource(config, track, subscription, options.log, options.fps, videoTrackId)
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

      const payload = videoPayload(segment, this.#videoTrackId)

      if (!payload) {
        continue
      }

      const units = splitAccessUnits(payload, this.#config)

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
