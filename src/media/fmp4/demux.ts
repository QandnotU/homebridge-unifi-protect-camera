import type { AvcConfig } from './avcc.js'
import { NalType, isKeyframe, isParameterSet, iterateNalUnits, nalType } from './avcc.js'

/**
 * One decoded picture's worth of NAL units, ready to packetize.
 *
 * `timestamp` is in the stream's own decode-timestamp units — Protect rebases these to
 * zero at the start of a session. Converting to the RTP 90 kHz clock is the sender's job,
 * since only it knows the timescale that was negotiated.
 */
export interface AccessUnit {
  readonly nals: readonly Buffer[]
  readonly timestamp: number
  readonly keyframe: boolean
}

/** Whether a NAL unit carries coded picture data (ISO/IEC 14496-10 Table 7-1). */
function isVideoCodingLayer(nal: Buffer): boolean {
  const type = nalType(nal)

  return (type >= NalType.NON_IDR) && (type <= NalType.IDR)
}

/**
 * Split an `mdat` payload into access units.
 *
 * A new access unit begins at an access unit delimiter, at a parameter set or SEI that
 * follows picture data, or at the second and subsequent coded slices. This is the
 * conservative reading of ISO/IEC 14496-10 §7.4.1.2.3 — it never merges two pictures,
 * which would desynchronise RTP timestamps and produce the stutter that looks like a
 * network problem but is not.
 */
export function splitAccessUnits(payload: Buffer, config: AvcConfig): AccessUnit[] {
  const units: AccessUnit[] = []

  let current: Buffer[] = []
  let sawPictureData = false

  const flush = (): void => {
    if (current.length === 0) {
      return
    }

    units.push({ keyframe: current.some(isKeyframe), nals: current, timestamp: 0 })
    current = []
    sawPictureData = false
  }

  for (const nal of iterateNalUnits(payload, config.nalLengthSize)) {
    const type = nalType(nal)
    const startsNewUnit = (type === NalType.AUD)
      || (sawPictureData && (isParameterSet(nal) || (type === NalType.SEI)))
      || (sawPictureData && isVideoCodingLayer(nal))

    if (startsNewUnit) {
      flush()
    }

    current.push(nal)

    if (isVideoCodingLayer(nal)) {
      sawPictureData = true
    }
  }

  flush()

  return units
}

/**
 * Attach decode timestamps to access units.
 *
 * Protect supplies one timestamp per picture when the session opts in. When the counts
 * agree we use them directly. When they do not — which happens if a segment is truncated
 * or the controller batches differently than expected — we fall back to advancing evenly
 * from the first timestamp, because a plausible monotonic clock degrades far better than
 * timestamps attached to the wrong pictures.
 */
export function applyTimestamps(
  units: readonly AccessUnit[],
  timestamps: readonly number[] | undefined,
  fallbackStart: number,
  fallbackStep: number,
): AccessUnit[] {
  if (units.length === 0) {
    return []
  }

  if (timestamps && (timestamps.length === units.length)) {
    return units.map((unit, index) => ({ ...unit, timestamp: timestamps[index] ?? fallbackStart }))
  }

  const start = timestamps?.[0] ?? fallbackStart

  return units.map((unit, index) => ({ ...unit, timestamp: start + (index * fallbackStep) }))
}

/**
 * Ensure a keyframe access unit carries the parameter sets a decoder needs.
 *
 * Protect's in-band stream usually omits SPS and PPS, keeping them only in the init
 * segment's `avcC`. A HomeKit client joining mid-stream has never seen that init segment,
 * so without this the first keyframe is undecodable and the camera tile stays black
 * until — by luck — a keyframe arrives that happens to carry them.
 */
export function withParameterSets(unit: AccessUnit, config: AvcConfig): AccessUnit {
  if (!unit.keyframe || unit.nals.some(isParameterSet)) {
    return unit
  }

  return { ...unit, nals: [...config.sps, ...config.pps, ...unit.nals] }
}
