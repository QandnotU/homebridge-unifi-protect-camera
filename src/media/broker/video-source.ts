import type { Camera } from 'unifi-protect'

import type { AccessUnit } from '../fmp4/demux.js'
import type { AvcConfig } from '../fmp4/avcc.js'
import type { ScopedLogger } from '../../core/logger.js'
import type { TrackInfo } from '../fmp4/init-segment.js'
import { applyTimestamps, splitAccessUnits, withParameterSets } from '../fmp4/demux.js'
import { readAvcConfig } from '../fmp4/avcc.js'
import { iterateBoxes } from '../fmp4/boxes.js'
import { parseMoof, readBaseMediaDecodeTime, readVideoTrackId } from '../fmp4/moof.js'
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
export function videoTrack(segment: { data?: Buffer, moof?: Buffer }, videoTrackId: number | null):
  { payload: Buffer, compositionOffsets: readonly number[], sampleCount: number } | null {
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
        return { compositionOffsets: video.compositionOffsets, payload: data.subarray(start, end), sampleCount: video.sampleCount }
      }
    }
  }

  // No usable sample table: fall back to the whole mdat body. The NAL walk will stop when
  // it reaches audio, so this still yields the pictures — just with the timestamp
  // mismatch described above. A degraded stream beats no stream.
  for (const box of iterateBoxes(data)) {
    if (box.type === 'mdat') {
      return { compositionOffsets: [], payload: box.body, sampleCount: 0 }
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
  readonly #subscription: AsyncIterable<{ type: string, data?: Buffer, mdat?: Buffer, moof?: Buffer, timestamps?: number[], discontinuity?: true }>
    & { stats?: { delivered: number, discarded: number, peakQueueDepth: number, queueDepth: number } }
  readonly #log: ScopedLogger
  readonly #fps: number
  readonly #videoTrackId: number | null

  #mismatches = 0
  #sawComposition = false

  // Measurement only: how far our synthesised clock has drifted from the stream's own
  // tfdt timeline. Nothing acts on these — they exist to decide whether the timeline is
  // where the jitter comes from before any of the timing code is rewritten around it.
  #tfdtBase: number | null = null
  #clockBase = 0
  #driftNow = 0
  #driftPeak = 0
  #driftSamples = 0
  #discontinuities = 0
  #trunDisagreements = 0

  private constructor(
    config: AvcConfig,
    track: TrackInfo,
    subscription: AsyncIterable<{ type: string, data?: Buffer, mdat?: Buffer, moof?: Buffer, timestamps?: number[], discontinuity?: true }>
      & { stats?: { delivered: number, discarded: number, peakQueueDepth: number, queueDepth: number } },
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
   * Upstream queue health. `discarded` above zero means we are not draining Protect fast
   * enough and segments are being dropped before we ever see them — which presents as the
   * stream freezing and then catching up.
   */
  get stats(): { delivered: number, discarded: number, peakQueueDepth: number, queueDepth: number } | null {
    return this.#subscription.stats ?? null
  }

  /**
   * Drift between our synthesised clock and the stream's tfdt timeline, in ticks.
   *
   * Zero means reconstructing the clock from per-segment spacing agrees with what the
   * controller actually stamped, and the timeline is not the source of our jitter. A
   * figure that grows with time means it is.
   */
  get timeline(): {
    driftNow: number, driftPeak: number, samples: number, discontinuities: number,
    anchored: boolean, mismatches: number, trunDisagreements: number,
    } {
    return {
      anchored: this.#tfdtBase !== null,
      discontinuities: this.#discontinuities,
      driftNow: this.#driftNow,
      driftPeak: this.#driftPeak,
      mismatches: this.#mismatches,
      samples: this.#driftSamples,
      trunDisagreements: this.#trunDisagreements,
    }
  }

  /**
   * Yield access units on a continuous, strictly increasing timeline.
   *
   * Protect's decode timestamps are **segment-relative**, not a stream clock. Measured
   * against a live camera, each segment restarts near zero:
   *
   * ```
   *   segment 1:   0, 3000, 6000, 9000
   *   segment 2: 133, 3133, 6133
   *   segment 3: 233, 3233, 6233
   * ```
   *
   * Within a segment the step is exactly one frame (3000 ticks at 30 fps on a 90 kHz
   * timescale), but the base creeps by about 100 ticks per segment while the segment
   * itself covers 9000. Passing those through as RTP timestamps makes the clock jump
   * backwards on every segment boundary, and a receiver treats that as a discontinuity —
   * the picture updates once every several seconds while we happily send 30 fps.
   *
   * So the per-segment offsets are used for *intra*-segment spacing, which they describe
   * correctly, and the segments are laid end to end on our own running clock.
   *
   * Keyframes are also given the parameter sets a decoder needs, because Protect keeps SPS
   * and PPS in the init segment and a client joining mid-stream never saw it.
   */
  async *accessUnits(): AsyncGenerator<AccessUnit> {
    // The nominal frame interval, used only until the controller's own timestamps reveal
    // the real one.
    //
    // The configured frame rate is not the delivered frame rate. A channel set to 30 fps
    // was measured delivering closer to 25, and pacing to the nominal figure makes our
    // media clock run ~20% fast: the sender waits longer and longer for frames that are
    // already late, until it is far enough behind to resync. Measured against a live
    // client that produced 771 ms of interarrival jitter with zero packet loss — the
    // stream was never losing anything, it was arriving at wildly uneven intervals.
    const nominalStep = Math.max(1, Math.round(this.#track.timescale / Math.max(1, this.#fps)))

    let step = nominalStep
    let clock = 0

    for await (const segment of this.#subscription) {
      if ((segment.type !== 'media') || !segment.mdat) {
        continue
      }

      const track = videoTrack(segment, this.#videoTrackId)

      if (!track) {
        continue
      }

      if (segment.discontinuity) {
        // The controller reconnected and restarted its timeline near zero. Re-anchor the
        // comparison rather than reporting the jump as drift.
        this.#discontinuities += 1
        this.#tfdtBase = null
      }

      const tfdt = ((this.#videoTrackId !== null) && segment.data)
        ? readBaseMediaDecodeTime(segment.data, this.#videoTrackId)
        : null

      if (tfdt !== null) {
        if (this.#tfdtBase === null) {
          this.#tfdtBase = tfdt
          this.#clockBase = clock
        } else {
          // How far the synthesised clock would have drifted by now. Kept as a measurement
          // of what anchoring removes, not as an input to anything.
          this.#driftNow = (clock - this.#clockBase) - (tfdt - this.#tfdtBase)
          this.#driftPeak = Math.max(this.#driftPeak, Math.abs(this.#driftNow))
          this.#driftSamples += 1
        }
      }

      const units = splitAccessUnits(track.payload, this.#config)

      if (units.length === 0) {
        continue
      }

      const supplied = segment.timestamps?.length ?? 0

      if ((supplied > 0) && (supplied !== units.length)) {
        // The splitter and the controller disagree about how many pictures this segment
        // holds. One of them is wrong, and the resulting timing is a guess either way —
        // which shows up as corruption rather than as an error.
        this.#mismatches += 1

        if (this.#mismatches <= 5) {
          this.#log.warn('Segment holds %s access units but %s timestamps; timing for it is approximate.',
            units.length.toString(), supplied.toString())
        }
      }

      // The sample table states how many pictures the fragment holds. When the splitter
      // disagrees, one of the two is wrong and this segment's timing is a guess.
      if ((track.sampleCount > 0) && (units.length !== track.sampleCount)) {
        this.#trunDisagreements += 1
      }

      const timed = applyTimestamps(units, segment.timestamps, 0, step)
      const first = timed[0]?.timestamp ?? 0

      // Anchor the segment to the controller's own timeline.
      //
      // Reconstructing a stream clock from per-segment spacing means re-estimating the
      // frame interval every fragment and keeping whatever each estimate got wrong. Measured
      // against a live camera that accumulated -397 ms over 43 seconds — a clock running
      // 0.92% slow, without bound, while the pictures themselves were fine.
      //
      // `tfdt` states the answer instead of inferring it: the session negotiates
      // rebaseTimestampsToZero, so it starts near zero and advances continuously, restarting
      // only across a reconnect that the library flags as `discontinuity`. Anchoring here
      // makes a bad per-segment estimate cost that segment alone rather than the session.
      const anchor = ((tfdt !== null) && (this.#tfdtBase !== null))
        ? (this.#clockBase + (tfdt - this.#tfdtBase))
        : clock

      for (const [index, unit] of timed.entries()) {
        // Guard against a non-monotonic segment: never emit a timestamp below the clock.
        const offset = Math.max(0, unit.timestamp - first)

        // Presentation time, not decode time. With B-frames the two differ, and RTP
        // carries presentation order — sending decode order plays pictures out of
        // sequence, which reads as smearing on movement while static areas stay sharp.
        const composition = track.compositionOffsets[index] ?? 0

        if ((composition !== 0) && !this.#sawComposition) {
          this.#sawComposition = true
          this.#log.info('Stream uses B-frames; applying composition time offsets.')
        }

        yield withParameterSets({ ...unit, timestamp: anchor + offset + composition }, this.#config)
      }

      const span = Math.max(0, (timed.at(-1)?.timestamp ?? first) - first)

      // Learn the real frame interval from the spacing within this segment, so the gap we
      // leave between segments matches what the camera actually delivers.
      if (timed.length >= 2) {
        const measured = Math.round(span / (timed.length - 1))

        // Ignore implausible values: a segment whose timestamps are damaged should not be
        // allowed to drag the clock off the rails.
        if ((measured > (nominalStep / 4)) && (measured < (nominalStep * 4))) {
          // Smooth, so one odd segment moves the estimate a little rather than a lot.
          step = Math.round((step * 3 + measured) / 4)
        }
      }

      clock += span + step
    }

    this.#log.debug('Protect stream ended.')
  }
}
