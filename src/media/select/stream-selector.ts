import type { StreamTier } from '../../protect/capabilities.js'

/**
 * How the chosen Protect stream reaches HomeKit.
 *
 * The ordering here is the project's whole premise: every step down costs latency, CPU
 * and image quality, so the selector takes the first mode that can satisfy the request.
 */
export type DeliveryMode =
  /** The camera's own H.264, repacketized into RTP. No decode, no scale, no encode. */
  | 'passthrough'
  /** Native H.264 at dimensions close to, but not exactly, what HomeKit asked for. */
  | 'passthrough-nearest'
  /** Re-encoded on the GPU because nothing native fits. Phase 6. */
  | 'hardware-transcode'
  /** Re-encoded on the CPU. Last resort. Phase 6. */
  | 'software-transcode'

/** What HomeKit asked for, normalised to bits per second. */
export interface StreamRequest {
  readonly width: number
  readonly height: number
  readonly fps: number
  /** Ceiling HomeKit negotiated. A protocol constraint, not a suggestion. */
  readonly maxBitrate: number
}

export interface SelectionOptions {
  /**
   * Maximum HomeKit Quality. Prefers the highest-quality compatible source and never
   * steps down to save bandwidth. It does not override what HomeKit negotiated.
   */
  readonly maximumQuality: boolean
  /** The codec the camera is currently emitting. */
  readonly codec: string
}

export interface StreamSelection {
  readonly tier: StreamTier
  readonly mode: DeliveryMode
  /** True when the tier's dimensions equal the request exactly. */
  readonly exactDimensions: boolean
  /** True when the tier's configured bitrate exceeds what HomeKit negotiated. */
  readonly overBudget: boolean
  /** Human-readable reasons, surfaced in the session diagnostic. */
  readonly notes: readonly string[]
}

function pixels(tier: StreamTier): number {
  return tier.width * tier.height
}

/** Tiers we can actually open: enabled, RTSP-reachable, and carrying real dimensions. */
function usableTiers(tiers: readonly StreamTier[]): StreamTier[] {
  return tiers.filter(tier => tier.enabled && (tier.width > 0) && (tier.height > 0))
}

/**
 * Choose the Protect stream that best satisfies a HomeKit request.
 *
 * Returns null when the camera offers nothing usable, which the caller should treat as a
 * failed session rather than a reason to transcode from nothing.
 *
 * The classic HomeKit path is H.264 only. A camera emitting HEVC therefore cannot be
 * passed through at all and is marked for transcoding — which is exactly the trade
 * recorded in ARCHITECTURE.md §4.1, and the reason these cameras stay on H.264 until
 * HKSV3 support exists.
 */
export function selectStream(
  request: StreamRequest,
  tiers: readonly StreamTier[],
  options: SelectionOptions,
): StreamSelection | null {
  const candidates = usableTiers(tiers)

  if (candidates.length === 0) {
    return null
  }

  const notes: string[] = []

  // A codec HomeKit's classic path cannot carry forces a transcode whatever we pick, so
  // choose on quality alone and let Phase 6 do the conversion.
  if (options.codec !== 'h264') {
    const best = [...candidates].sort((a, b) => pixels(b) - pixels(a))[0]

    return {
      exactDimensions: false,
      mode: 'hardware-transcode',
      notes: [`camera is emitting ${options.codec.toUpperCase()}, which the classic HomeKit path cannot carry`],
      overBudget: false,
      tier: best!,
    }
  }

  const exact = candidates.filter(tier => (tier.width === request.width) && (tier.height === request.height))

  if (exact.length > 0) {
    // Among exact matches prefer the highest bitrate in quality mode, the lowest that
    // still meets the request otherwise.
    const tier = [...exact].sort((a, b) => options.maximumQuality ? (b.bitrate - a.bitrate) : (a.bitrate - b.bitrate))[0]!

    return {
      exactDimensions: true,
      mode: 'passthrough',
      notes: notes.concat(bitrateNotes(tier, request)),
      overBudget: tier.bitrate > request.maxBitrate,
      tier,
    }
  }

  // No exact match. Prefer the largest native stream that does not exceed the request,
  // so the client scales down rather than up — upscaling a smaller stream looks worse
  // than receiving a slightly smaller one.
  const atOrBelow = candidates
    .filter(tier => (tier.width <= request.width) && (tier.height <= request.height))
    .sort((a, b) => pixels(b) - pixels(a))

  const chosen = atOrBelow[0] ?? [...candidates].sort((a, b) => pixels(a) - pixels(b))[0]!

  notes.push(`no native ${request.width.toString()}x${request.height.toString()} stream; ` +
    `sending ${chosen.width.toString()}x${chosen.height.toString()} natively instead of re-encoding`)

  if (atOrBelow.length === 0) {
    notes.push('every native stream is larger than the request')
  }

  return {
    exactDimensions: false,
    mode: 'passthrough-nearest',
    notes: notes.concat(bitrateNotes(chosen, request)),
    overBudget: chosen.bitrate > request.maxBitrate,
    tier: chosen,
  }
}

function bitrateNotes(tier: StreamTier, request: StreamRequest): string[] {
  if (tier.bitrate <= request.maxBitrate) {
    return []
  }

  return [`channel is configured at ${formatBitrate(tier.bitrate)} but HomeKit negotiated ` +
    `${formatBitrate(request.maxBitrate)}; lower the channel bitrate in Protect if the stream stutters`]
}

export function formatBitrate(bps: number): string {
  return (bps >= 1e6) ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3).toString()} Kbps`
}

/** Whether a mode re-encodes video. Used by the diagnostics and the quality reporting. */
export function isTranscoding(mode: DeliveryMode): boolean {
  return (mode === 'hardware-transcode') || (mode === 'software-transcode')
}

/** Label for the session diagnostic's `Mode:` line. */
export function describeMode(mode: DeliveryMode): string {
  switch (mode) {
    case 'passthrough': return 'Direct H.264 Passthrough'
    case 'passthrough-nearest': return 'Direct H.264 Passthrough (nearest resolution)'
    case 'hardware-transcode': return 'VideoToolbox Transcode'
    case 'software-transcode': return 'Software Transcode'
    default: return mode
  }
}
