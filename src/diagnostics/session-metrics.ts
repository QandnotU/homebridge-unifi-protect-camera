import type { DeliveryMode, StreamSelection } from '../media/select/stream-selector.js'
import type { SenderStats } from '../media/rtp/sender.js'
import { describeMode, formatBitrate, isTranscoding } from '../media/select/stream-selector.js'
import { formatLevel, formatProfile } from '../media/fmp4/avcc.js'

/** What HomeKit asked for, as reported in `StartStreamRequest.video`. */
export interface RequestedVideo {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly maxBitrate: number
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
  #codec = 'unknown'
  #sourceOpenAt: number | null = null
  #firstPacketAt: number | null = null
  #firstKeyframeAt: number | null = null
  #accessUnits = 0
  #keyframes = 0
  #reconfigurations: { at: number, height: number, maxBitrate: number, width: number }[] = []

  constructor(sessionId: string) {
    this.#sessionId = sessionId
  }

  get sessionId(): string {
    return this.#sessionId
  }

  markRequest(request: RequestedVideo): void {
    this.#request = request
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

    const tier = selection.tier
    const ttff = (this.#firstPacketAt === null) ? 'no video' : `${(this.#firstPacketAt - this.#startedAt).toString()} ms`

    return `${request.width.toString()}x${request.height.toString()}@${request.fps.toString()}fps ` +
      `${formatBitrate(request.maxBitrate)} -> ${tier.channelName} ` +
      `${tier.width.toString()}x${tier.height.toString()}@${tier.fps.toString()}fps | ` +
      `${describeMode(selection.mode)} | first packet ${ttff} | ${stats.packetsSent.toString()} packets`
  }

  /** The full record, for debug logging and the plugin UI. */
  report(stats: SenderStats): string[] {
    const request = this.#request
    const selection = this.#selection
    const lines: string[] = []

    if (!request || !selection) {
      return [`Session ${this.#sessionId} ended before a stream was negotiated.`]
    }

    const tier = selection.tier

    lines.push('HomeKit Request')
    lines.push(`  Resolution : ${request.width.toString()}x${request.height.toString()}`)
    lines.push(`  FPS        : ${request.fps.toString()}`)
    lines.push(`  Bitrate    : ${formatBitrate(request.maxBitrate)}`)
    lines.push(`  Profile    : ${formatProfile(request.profile)}`)
    lines.push(`  Level      : ${formatLevel(request.level)}`)
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
    lines.push(`  Frames     : ${this.#accessUnits.toString()} (${this.#keyframes.toString()} keyframes)`)
    lines.push(`  Sent       : ${stats.packetsSent.toString()} packets, ${formatBytes(stats.bytesSent)}`)
    lines.push(`  Send errors: ${stats.sendErrors.toString()}`)
    lines.push(`  RTCP in    : ${stats.inboundPackets.toString()}`)

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
