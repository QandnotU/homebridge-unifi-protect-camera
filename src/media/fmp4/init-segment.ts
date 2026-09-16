import { findBoxDeep } from './boxes.js'

/** RTP carries video on a 90 kHz clock (RFC 3551 §5.1). */
export const RTP_VIDEO_CLOCK = 90_000

export interface TrackInfo {
  /** Ticks per second in the track's own timeline. */
  readonly timescale: number
  readonly width: number
  readonly height: number
}

/**
 * Read the media timescale from `mdhd` (ISO/IEC 14496-12 §8.4.2).
 *
 * This is what makes Protect's decode timestamps meaningful. Without it we would be
 * guessing at the unit, and a wrong guess does not fail loudly — it produces video that
 * plays at the wrong speed, which is far harder to diagnose than a stream that never
 * starts.
 */
export function readTimescale(initSegment: Buffer): number | null {
  const mdhd = findBoxDeep(initSegment, 'mdhd')

  if (!mdhd || (mdhd.body.length < 4)) {
    return null
  }

  const version = mdhd.body.readUInt8(0)
  // After the 4-byte version and flags: v0 has two 32-bit times, v1 two 64-bit ones.
  const offset = (version === 1) ? 20 : 12

  if ((offset + 4) > mdhd.body.length) {
    return null
  }

  const timescale = mdhd.body.readUInt32BE(offset)

  return (timescale > 0) ? timescale : null
}

/**
 * Read the coded dimensions from the visual sample entry, where width and height sit at a
 * fixed offset within the `VisualSampleEntry` record.
 */
export function readDimensions(initSegment: Buffer): { width: number, height: number } | null {
  for (const type of ['avc1', 'hvc1', 'hev1', 'encv']) {
    const entry = findBoxDeep(initSegment, type)

    if (!entry || (entry.body.length < 28)) {
      continue
    }

    // Within the body: 8 bytes SampleEntry, 16 bytes pre-defined/reserved, then width and
    // height as 16-bit values.
    const width = entry.body.readUInt16BE(24)
    const height = entry.body.readUInt16BE(26)

    if ((width > 0) && (height > 0)) {
      return { height, width }
    }
  }

  return null
}

export function readTrackInfo(initSegment: Buffer): TrackInfo | null {
  const timescale = readTimescale(initSegment)
  const dimensions = readDimensions(initSegment)

  if ((timescale === null) || !dimensions) {
    return null
  }

  return { height: dimensions.height, timescale, width: dimensions.width }
}

/**
 * Convert a timestamp from the track's timescale to RTP's 90 kHz clock, wrapped into the
 * 32 bits an RTP header carries.
 */
export function toRtpTimestamp(timestamp: number, timescale: number): number {
  return Math.round((timestamp * RTP_VIDEO_CLOCK) / timescale) >>> 0
}
