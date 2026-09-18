import type { DeliveryMode, StreamSelection } from '../media/select/stream-selector.js'
import type { StreamTier } from '../protect/capabilities.js'
import type { ReceiverReport } from '../media/rtp/srtcp.js'
import type { SenderStats } from '../media/rtp/sender.js'
import { describeMode, formatBitrate, isTranscoding } from '../media/select/stream-selector.js'
import { formatHapLevel, formatHapProfile } from '../homekit/hap-constants.js'

/** What HomeKit asked for, as reported in `StartStreamRequest.video`. */
export interface RequestedVideo {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly maxBitrate: number
  /** HAP enum indices, not H.264 wire values. */
  readonly profile: number
  readonly level: number
  readonly ssrc: number
  readonly mtu: number
  /** True when HomeKit is on the local network rather than relayed through a hub. */
  readonly local: boolean
}

/**
 * Per-session diagnostics.
 *
 * The point of this is to make one question answerable at a glance: is HomeKit receiving
 * the camera's own video, or something we re-encoded? Every timing here is measured, not
 * estimated, so a change in the pipeline shows up as a number rather than an impression.
 */
export class SessionMetrics {
  readonly #sessionId: string
  readonly #startedAt = Date.now()

  #request: RequestedVideo | null = null
  #selection: StreamSelection | null = null

  /**
   * The tier actually streamed, when it is not the one selection chose.
   *
   * A summary that names a different channel than the session used is worse than no
   * summary: it was read as evidence during diagnosis before the contradiction was spotted.
   */
  #actualTier: StreamTier | null = null
  #codec = 'unknown'
  #sourceOpenAt: number | null = null
  #firstPacketAt: number | null = null
  #firstKeyframeAt: number | null = null
  #accessUnits = 0
  #keyframes = 0
  #reconfigurations: { at: number, height: number, maxBitrate: number, width: number }[] = []
  #reports = 0
  #worstFractionLost = 0
  #lastCumulativeLost = 0
  #peakJitter = 0
  #lastJitter = 0
  #sendSkewTotal = 0
  #sendSkewCount = 0
  #sendSkewMax = 0
  #sendSkewSpikes = 0
  #previousSendAt = 0
  #previousStamp = 0

  constructor(sessionId: string) {
    this.#sessionId = sessionId
  }

  get sessionId(): string {
    return this.#sessionId
  }

  markRequest(request: RequestedVideo): void {
    this.#request = request
  }

  /** Record the tier the stream really opened on, overriding the selected one. */
  markActualTier(tier: StreamTier): void {
    this.#actualTier = tier
  }

  markSelection(selection: StreamSelection, codec: string): void {
    this.#selection = selection
    this.#codec = codec
  }

  /** The Protect stream is open and its configuration is readable. */
  markSourceOpen(): void {
    this.#sourceOpenAt ??= Date.now()
  }

  markFirstPacket(): void {
    this.#firstPacketAt ??= Date.now()
  }

  /**
   * Record how far this picture's send time drifted from what its timestamp promised.
   *
   * This is RFC 3550's D term computed at the sender. HomeKit's jitter figure mixes our
   * timing with the network's; measuring the same quantity here separates them. A large
   * value on this side means the fault is ours before a packet ever leaves.
   */
  markSend(rtpTimestamp: number): void {
    const now = Date.now()

    if (this.#previousSendAt > 0) {
      const arrivalMs = now - this.#previousSendAt

      // RTP timestamps are 32-bit and wrap. Subtracting them as plain integers turns a
      // wrap into a 2^32-tick step — about thirteen hours — which swamps the mean and
      // makes the whole measurement useless. Truncating to a signed 32-bit difference
      // reads a wrap as the small step it actually is.
      const ticks = (rtpTimestamp - this.#previousStamp) | 0
      const timestampMs = (ticks / 90_000) * 1000
      const skew = Math.abs(arrivalMs - timestampMs)

      this.#sendSkewTotal += skew
      this.#sendSkewCount += 1
      this.#sendSkewMax = Math.max(this.#sendSkewMax, skew)

      // Count the outliers separately. A mean hides them, and it is precisely the rare
      // large discontinuity that drives RFC 3550's smoothed estimate to where we see it.
      if (skew > 100) {
        this.#sendSkewSpikes += 1
      }
    }

    this.#previousSendAt = now
    this.#previousStamp = rtpTimestamp
  }

  markAccessUnit(keyframe: boolean): void {
    this.#accessUnits += 1

    if (keyframe) {
      this.#keyframes += 1
      this.#firstKeyframeAt ??= Date.now()
    }
  }

  /**
   * Record a mid-session reconfiguration.
   *
   * Appended rather than overwritten: Apple's adaptive step down from 720p to 360p is
   * precisely the behaviour we are trying to understand, and a record that shows only the
   * final state hides it.
   */
  markReconfigure(width: number, height: number, maxBitrate: number): void {
    this.#reconfigurations.push({ at: Date.now() - this.#startedAt, height, maxBitrate, width })
  }

  /**
   * Record what the receiver says about the stream we are sending it.
   *
   * This is the only direct measurement of loss a sender has. Everything else — the
   * picture breaking up on movement, HomeKit renegotiating downward — is inference from
   * symptoms.
   */
  markReceiverReport(report: ReceiverReport): void {
    this.#reports += 1
    this.#worstFractionLost = Math.max(this.#worstFractionLost, report.fractionLost)
    this.#lastCumulativeLost = report.cumulativeLost
    this.#peakJitter = Math.max(this.#peakJitter, report.jitter)
    this.#lastJitter = report.jitter
  }

  get mode(): DeliveryMode | null {
    return this.#selection?.mode ?? null
  }

  /** One line for the ordinary log: what was asked for, what was sent, how fast. */
  summary(stats: SenderStats): string {
    const request = this.#request
    const selection = this.#selection

    if (!request || !selection) {
      return `${this.#sessionId}: session ended before it started`
    }

    const tier = this.#actualTier ?? selection.tier
    const ttff = (this.#firstPacketAt === null) ? 'no video' : `${(this.#firstPacketAt - this.#startedAt).toString()} ms`

    return `${request.width.toString()}x${request.height.toString()}@${request.fps.toString()}fps ` +
      `${formatBitrate(request.maxBitrate)} -> ${tier.channelName} ` +
      `${tier.width.toString()}x${tier.height.toString()}@${tier.fps.toString()}fps | ` +
      `${describeMode(selection.mode)} | first packet ${ttff} | ${stats.packetsSent.toString()} packets` +
      ((this.#reports > 0) ? ` | ${this.#lastCumulativeLost.toString()} lost` : '')
  }

  /** The full record, for debug logging and the plugin UI. */
  report(stats: SenderStats): string[] {
    const request = this.#request
    const selection = this.#selection
    const lines: string[] = []

    if (!request || !selection) {
      return [`Session ${this.#sessionId} ended before a stream was negotiated.`]
    }

    const tier = this.#actualTier ?? selection.tier

    lines.push('HomeKit Request')
    lines.push(`  Resolution : ${request.width.toString()}x${request.height.toString()}`)
    lines.push(`  FPS        : ${request.fps.toString()}`)
    lines.push(`  Bitrate    : ${formatBitrate(request.maxBitrate)}`)
    lines.push(`  Profile    : ${formatHapProfile(request.profile)}`)
    lines.push(`  Level      : ${formatHapLevel(request.level)}`)
    lines.push(`  MTU        : ${request.mtu.toString()}`)
    lines.push(`  Destination: ${request.local ? 'Local' : 'Remote'}`)

    lines.push('Protect Source')
    lines.push(`  Stream     : ${tier.channelName} (${tier.quality})`)
    lines.push(`  Resolution : ${tier.width.toString()}x${tier.height.toString()}`)
    lines.push(`  FPS        : ${tier.fps.toString()}`)
    lines.push(`  Bitrate    : ${formatBitrate(tier.bitrate)}${selection.overBudget ? ' (over budget)' : ''}`)
    lines.push(`  Codec      : ${this.#codec.toUpperCase()}`)

    lines.push('Delivery')
    lines.push(`  Mode       : ${describeMode(selection.mode)}`)
    lines.push(`  Transcode  : ${isTranscoding(selection.mode) ? 'Yes' : 'No'}`)
    lines.push(`  Source open: ${this.#since(this.#sourceOpenAt)}`)
    lines.push(`  First RTP  : ${this.#since(this.#firstPacketAt)}`)
    lines.push(`  First IDR  : ${this.#since(this.#firstKeyframeAt)}`)
    const elapsedSeconds = (Date.now() - this.#startedAt) / 1000
    const deliveredFps = (elapsedSeconds > 0) ? (this.#accessUnits / elapsedSeconds) : 0

    // Delivered frame rate, not the configured one. A stream that is keeping up shows
    // roughly the channel's rate; anything materially lower is a pause the viewer sees.
    lines.push(`  Frames     : ${this.#accessUnits.toString()} (${this.#keyframes.toString()} keyframes), ${deliveredFps.toFixed(1)} fps delivered`)
    lines.push(`  Sent       : ${stats.packetsSent.toString()} packets, ${formatBytes(stats.bytesSent)}`)
    lines.push(`  Send errors: ${stats.sendErrors.toString()}`)
    lines.push(`  RTCP in    : ${stats.inboundPackets.toString()}`)

    if (this.#reports > 0) {
      const share = (stats.packetsSent > 0)
        ? ` (${((this.#lastCumulativeLost / stats.packetsSent) * 100).toFixed(2)}% of packets sent)`
        : ''

      lines.push(`  Reports in : ${this.#reports.toString()}`)
      lines.push(`  Packet loss: ${this.#lastCumulativeLost.toString()} total${share}, worst interval ${(this.#worstFractionLost * 100).toFixed(2)}%`)
      lines.push(`  Jitter     : ${this.#lastJitter.toString()} ticks now, ${this.#peakJitter.toString()} peak (${(this.#peakJitter / 90).toFixed(0)} ms)`)
    }

    if (this.#sendSkewCount > 0) {
      const meanSkew = (this.#sendSkewTotal / this.#sendSkewCount).toFixed(1)

      lines.push(`  Send skew  : ${meanSkew} ms mean, ${this.#sendSkewMax.toFixed(0)} ms worst, ` +
        `${this.#sendSkewSpikes.toString()} over 100 ms (our own timing)`)
    } else {
      lines.push('  Packet loss: no receiver reports decoded')
    }

    for (const note of selection.notes) {
      lines.push(`  Note       : ${note}`)
    }

    for (const change of this.#reconfigurations) {
      lines.push(`  Reconfigured at ${change.at.toString()} ms: ` +
        `${change.width.toString()}x${change.height.toString()} ${formatBitrate(change.maxBitrate)}`)
    }

    return lines
  }

  #since(at: number | null): string {
    return (at === null) ? 'never' : `${(at - this.#startedAt).toString()} ms`
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e6) {
    return `${(bytes / 1e6).toFixed(1)} MB`
  }

  if (bytes >= 1e3) {
    return `${(bytes / 1e3).toFixed(1)} KB`
  }

  return `${bytes.toString()} B`
}
