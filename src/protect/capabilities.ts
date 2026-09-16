import type { ProtectCameraConfig } from 'unifi-protect'

/**
 * The Protect channel name that designates a doorbell's secondary package camera. It is
 * a separate optical path, not a quality tier, so it is excluded from the tier list and
 * surfaced as its own accessory in a later phase.
 */
export const PACKAGE_CHANNEL_NAME = 'Package Camera'

/**
 * Quality tiers, in Apple's HKSV3 vocabulary rather than Protect's.
 *
 * The two happen to line up for every camera we have seen, but keeping our own names
 * means the tier model stays the plugin's own abstraction: it is what the classic
 * renderer flattens into a resolution list today, and what a secure-video renderer would
 * emit almost verbatim as `SupportedVideoStreamTiers` later. See ARCHITECTURE.md §5.1.
 */
export type StreamQuality = 'high' | 'medium' | 'low'

/** Frame rates HomeKit is willing to negotiate. Anything else must not be advertised. */
export const HOMEKIT_FRAME_RATES = [15, 24, 30] as const

/**
 * One concrete, natively-available encoding of a camera. Every field is measured from the
 * controller — nothing here is assumed or defaulted.
 */
export interface StreamTier {
  readonly quality: StreamQuality

  /** Protect's own channel id and name, for logging and for opening the stream. */
  readonly channelId: number
  readonly channelName: string

  readonly width: number
  readonly height: number
  readonly fps: number

  /** Bits per second, as Protect reports them. */
  readonly bitrate: number
  readonly minBitrate: number
  readonly maxBitrate: number

  /** Frame rates this channel can be reconfigured to. */
  readonly frameRates: readonly number[]

  readonly rtspEnabled: boolean
  readonly rtspAlias: string | null

  /** False when the channel is configured but switched off in Protect. */
  readonly enabled: boolean
}

/**
 * Everything the plugin needs to know about one camera, derived from the Protect
 * bootstrap. This is the input to both the HomeKit renderer and the stream selector.
 */
export interface CameraCapabilities {
  readonly id: string
  readonly mac: string
  readonly name: string
  readonly model: string
  readonly type: string
  readonly firmware: string | null

  /** The codec the camera is emitting right now. */
  readonly codec: string
  readonly supportedCodecs: readonly string[]
  readonly supportsHevc: boolean

  readonly hasMic: boolean
  readonly hasSpeaker: boolean
  readonly isDoorbell: boolean
  readonly hasPackageCamera: boolean
  readonly audioCodecs: readonly string[]
  readonly smartDetectTypes: readonly string[]

  /** Quality tiers, highest first. Never includes the package-camera channel. */
  readonly tiers: readonly StreamTier[]
  readonly packageChannel: StreamTier | null
}

function pixels(tier: { height: number, width: number }): number {
  return tier.width * tier.height
}

/**
 * Assign quality labels by size rather than by Protect's channel names, so a camera that
 * names or orders its channels differently still produces a sane tier set. The names are
 * retained on each tier for logging.
 */
function assignQualities(count: number): StreamQuality[] {
  if (count <= 1) {
    return ['high']
  }

  if (count === 2) {
    return ['high', 'low']
  }

  // Highest and lowest anchor the ends; everything between is medium.
  return ['high', ...Array.from<StreamQuality>({ length: count - 2 }).fill('medium'), 'low']
}

function toTier(channel: ProtectCameraConfig['channels'][number], quality: StreamQuality): StreamTier {
  return {
    bitrate: channel.bitrate,
    channelId: channel.id,
    channelName: channel.name,
    enabled: channel.enabled !== false,
    fps: channel.fps,
    frameRates: [...channel.fpsValues].sort((a, b) => b - a),
    height: channel.height,
    maxBitrate: channel.maxBitrate,
    minBitrate: channel.minBitrate,
    quality,
    rtspAlias: channel.rtspAlias,
    rtspEnabled: channel.isRtspEnabled,
    width: channel.width,
  }
}

/**
 * Build the capability model for one camera from its Protect configuration.
 *
 * Channels with nonsensical dimensions are dropped rather than trusted — a camera that is
 * still provisioning can briefly report a 0x0 channel, and advertising that to HomeKit
 * produces a camera tile that never loads.
 */
export function readCapabilities(config: ProtectCameraConfig): CameraCapabilities {
  const flags = config.featureFlags

  const usable = (config.channels ?? []).filter(channel => (channel.width > 0) && (channel.height > 0) && (channel.fps > 0))

  const packageChannel = usable.find(channel => channel.name === PACKAGE_CHANNEL_NAME)

  const primary = usable
    .filter(channel => channel.name !== PACKAGE_CHANNEL_NAME)
    .sort((a, b) => (pixels(b) - pixels(a)) || (b.fps - a.fps))

  const qualities = assignQualities(primary.length)
  const supportedCodecs = flags.videoCodecs ?? []

  return {
    audioCodecs: flags.audioCodecs ?? [],
    codec: config.videoCodec,
    firmware: config.firmwareVersion,
    hasMic: flags.hasMic,
    hasPackageCamera: flags.hasPackageCamera,
    // hasSpeaker is reported both at the top level and under featureFlags; hasMic only
    // under featureFlags. Read each from where it actually lives — an absent flag read
    // from the wrong path is falsy, which silently becomes a definite "no".
    hasSpeaker: flags.hasSpeaker || config.hasSpeaker,
    id: config.id,
    isDoorbell: flags.isDoorbell,
    mac: config.mac,
    model: config.marketName,
    // `name` is optional in Protect: a freshly adopted camera can arrive without one.
    name: config.name ?? config.marketName ?? config.mac,
    packageChannel: packageChannel ? toTier(packageChannel, 'high') : null,
    smartDetectTypes: flags.smartDetectTypes ?? [],
    supportedCodecs,
    supportsHevc: supportedCodecs.includes('h265'),
    tiers: primary.map((channel, index) => toTier(channel, qualities[index] ?? 'medium')),
    type: config.type,
  }
}

/**
 * Format one tier for the log, e.g. `High 2688x1512@20fps 8.0/10.0 Mbps (rtsp)`.
 *
 * Both bitrates are shown deliberately. Protect reports a *configured* bitrate and a
 * higher channel *ceiling*, and quoting only one of them makes two tools disagree about
 * the same camera. Phase 2's bitrate decisions need the configured figure (what the
 * camera actually sends) while the ceiling bounds what it could be raised to.
 */
export function describeTier(tier: StreamTier): string {
  const configured = (tier.bitrate / 1e6).toFixed(1)
  const ceiling = (tier.maxBitrate / 1e6).toFixed(1)
  const rate = (configured === ceiling) ? `${configured} Mbps` : `${configured}/${ceiling} Mbps`

  return `${tier.channelName} ${tier.width.toString()}x${tier.height.toString()}@${tier.fps.toString()}fps ` +
    `${rate}${tier.rtspEnabled ? ' (rtsp)' : ''}${tier.enabled ? '' : ' [disabled]'}`
}

/** Join a list for prose: `30`, `30 or 24`, `30, 24 or 15`. */
export function joinOr(values: readonly (number | string)[]): string {
  const parts = values.map(String)

  if (parts.length <= 1) {
    return parts[0] ?? ''
  }

  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1] ?? ''}`
}

/**
 * Whether a tier's frame rate is one HomeKit will negotiate.
 *
 * A camera left on, say, 20 fps cannot be advertised honestly. Rather than advertising a
 * rate we do not deliver — which is what existing plugins do — we report the mismatch and
 * let the operator correct it, since {@link StreamTier.frameRates} usually contains a
 * conforming option.
 */
export function hasConformingFrameRate(tier: StreamTier): boolean {
  return (HOMEKIT_FRAME_RATES as readonly number[]).includes(tier.fps)
}

/** The conforming frame rates this channel could be reconfigured to, highest first. */
export function conformingAlternatives(tier: StreamTier): readonly number[] {
  return tier.frameRates.filter(rate => (HOMEKIT_FRAME_RATES as readonly number[]).includes(rate))
}
