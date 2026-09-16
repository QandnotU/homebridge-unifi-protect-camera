import type { Box } from './boxes.js'
import { findBoxDeep } from './boxes.js'

/**
 * H.264 NAL unit types we care about. The type occupies the low five bits of the first
 * byte of a NAL unit (ISO/IEC 14496-10 §7.3.1).
 */
export const NalType = {
  AUD: 9,
  IDR: 5,
  NON_IDR: 1,
  PPS: 8,
  SEI: 6,
  SPS: 7,
} as const

/** The Annex-B four-byte start code. */
export const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01])

export interface AvcConfig {
  /** `AVCProfileIndication` — 66 Baseline, 77 Main, 100 High. */
  readonly profile: number
  readonly profileCompatibility: number
  /** `AVCLevelIndication`, ten times the level number: 40 is level 4.0. */
  readonly level: number
  /** Bytes in each AVCC length prefix: 1, 2 or 4. */
  readonly nalLengthSize: number
  readonly sps: readonly Buffer[]
  readonly pps: readonly Buffer[]
}

/** The NAL unit type of a NAL unit body (no start code, no length prefix). */
export function nalType(nal: Buffer): number {
  return (nal[0] ?? 0) & 0x1f
}

export function isParameterSet(nal: Buffer): boolean {
  const type = nalType(nal)

  return (type === NalType.SPS) || (type === NalType.PPS)
}

/** Whether a NAL unit is an IDR slice, i.e. the start of a decodable picture. */
export function isKeyframe(nal: Buffer): boolean {
  return nalType(nal) === NalType.IDR
}

/**
 * Parse an `AVCDecoderConfigurationRecord` (ISO/IEC 14496-15 §5.2.4.1).
 *
 * Returns null rather than throwing on a malformed record: a truncated init segment
 * should fail the stream, not the process.
 */
export function parseAvcC(body: Buffer): AvcConfig | null {
  // configurationVersion, profile, compatibility, level, lengthSizeMinusOne, numSPS.
  if (body.length < 6) {
    return null
  }

  const nalLengthSize = (body.readUInt8(4) & 0x03) + 1
  const spsCount = body.readUInt8(5) & 0x1f

  let offset = 6
  const sps: Buffer[] = []

  for (let index = 0; index < spsCount; index++) {
    if ((offset + 2) > body.length) {
      return null
    }

    const length = body.readUInt16BE(offset)

    offset += 2

    if ((offset + length) > body.length) {
      return null
    }

    sps.push(body.subarray(offset, offset + length))
    offset += length
  }

  if (offset >= body.length) {
    return null
  }

  const ppsCount = body.readUInt8(offset)

  offset += 1

  const pps: Buffer[] = []

  for (let index = 0; index < ppsCount; index++) {
    if ((offset + 2) > body.length) {
      return null
    }

    const length = body.readUInt16BE(offset)

    offset += 2

    if ((offset + length) > body.length) {
      return null
    }

    pps.push(body.subarray(offset, offset + length))
    offset += length
  }

  return {
    level: body.readUInt8(3),
    nalLengthSize,
    pps,
    profile: body.readUInt8(1),
    profileCompatibility: body.readUInt8(2),
    sps,
  }
}

/**
 * Extract the H.264 configuration from a Protect init segment.
 *
 * `avcC` is located by type rather than by a fixed path, because it sits under `avc1`
 * normally but under `encv` when a protection scheme wraps the sample entry.
 */
export function readAvcConfig(initSegment: Buffer): AvcConfig | null {
  const box: Box | null = findBoxDeep(initSegment, 'avcC')

  return box ? parseAvcC(box.body) : null
}

/**
 * Walk the length-prefixed NAL units in an AVCC payload (an `mdat` body).
 *
 * AVCC samples are self-delimiting, so the sample boundaries in `trun` are not needed to
 * recover the NAL units — which is why this path does not parse `moof` at all.
 *
 * Stops at the first prefix that overruns the buffer rather than throwing.
 */
export function* iterateNalUnits(payload: Buffer, nalLengthSize: number): Generator<Buffer> {
  let offset = 0

  while ((offset + nalLengthSize) <= payload.length) {
    let length = 0

    for (let index = 0; index < nalLengthSize; index++) {
      length = (length << 8) | (payload[offset + index] ?? 0)
    }

    offset += nalLengthSize

    if ((length <= 0) || ((offset + length) > payload.length)) {
      return
    }

    yield payload.subarray(offset, offset + length)
    offset += length
  }
}

/** Concatenate NAL units into an Annex-B byte stream, each preceded by a start code. */
export function toAnnexB(nals: readonly Buffer[]): Buffer {
  const parts: Buffer[] = []

  for (const nal of nals) {
    parts.push(START_CODE, nal)
  }

  return Buffer.concat(parts)
}

/**
 * Macroblock count of a frame, per H.264's 16x16 macroblock grid. Partial rows and
 * columns each occupy a whole macroblock, which is why 1080 (67.5 rows) costs 68.
 */
export function macroblocks(width: number, height: number): number {
  return Math.ceil(width / 16) * Math.ceil(height / 16)
}

/**
 * `MaxFS` — the maximum frame size in macroblocks — for each H.264 level, from Table A-1
 * of ISO/IEC 14496-10. Levels are keyed as ten times the level number, matching
 * `AVCLevelIndication`.
 */
const MAX_FRAME_SIZE: ReadonlyArray<readonly [level: number, maxFs: number]> = [
  [10, 99], [11, 396], [12, 396], [13, 396],
  [20, 396], [21, 792], [22, 1620],
  [30, 1620], [31, 3600], [32, 5120],
  [40, 8192], [41, 8192], [42, 8704],
  [50, 22080], [51, 36864], [52, 36864],
  [60, 139264], [61, 139264], [62, 139264],
]

/**
 * The lowest H.264 level whose `MaxFS` admits this frame size, as ten times the level
 * number (40 is level 4.0). Null if no defined level is large enough.
 *
 * This is the constraint behind HomeKit's 1080p ceiling on the classic camera path.
 * HAP-NodeJS advertises at most level 4.0, whose MaxFS of 8192 macroblocks admits
 * 1920x1080 at 8160 and nothing larger — so 2688x1512, at 15960 macroblocks, cannot be
 * offered honestly there however the resolution list is written. See ARCHITECTURE.md §Q4.
 */
export function minimumLevelFor(width: number, height: number): number | null {
  const required = macroblocks(width, height)

  for (const [level, maxFs] of MAX_FRAME_SIZE) {
    if (required <= maxFs) {
      return level
    }
  }

  return null
}

/** Format a level indication for humans: 40 becomes `4.0`. */
export function formatLevel(level: number): string {
  return `${Math.floor(level / 10).toString()}.${(level % 10).toString()}`
}

/** Format a profile indication for humans. */
export function formatProfile(profile: number): string {
  switch (profile) {
    case 66: return 'Baseline'
    case 77: return 'Main'
    case 100: return 'High'
    default: return `profile ${profile.toString()}`
  }
}

/**
 * Read an unsigned Exp-Golomb value (`ue(v)`) starting at a bit offset.
 *
 * Returns null if the buffer runs out, rather than throwing on a truncated NAL.
 */
function readUnsignedExpGolomb(data: Buffer, startBit: number): number | null {
  let bit = startBit
  let leadingZeros = 0

  for (;;) {
    const byteIndex = bit >> 3

    if (byteIndex >= data.length) {
      return null
    }

    const value = ((data[byteIndex] ?? 0) >> (7 - (bit & 7))) & 1

    bit += 1

    if (value === 1) {
      break
    }

    leadingZeros += 1

    // Beyond this the value cannot be represented, and the NAL is not what we think.
    if (leadingZeros > 31) {
      return null
    }
  }

  let remainder = 0

  for (let index = 0; index < leadingZeros; index++) {
    const byteIndex = bit >> 3

    if (byteIndex >= data.length) {
      return null
    }

    remainder = (remainder * 2) + (((data[byteIndex] ?? 0) >> (7 - (bit & 7))) & 1)
    bit += 1
  }

  return ((2 ** leadingZeros) - 1) + remainder
}

/**
 * `first_mb_in_slice` from a coded slice NAL, or null if it cannot be read.
 *
 * This is the first field of the slice header (ISO/IEC 14496-10 §7.3.3), immediately after
 * the one-byte NAL header. It is what distinguishes the start of a new picture from a
 * continuation of the current one: a picture encoded as several slices produces several
 * VCL NALs, and only the first of them has `first_mb_in_slice == 0`.
 *
 * Treating every slice as a new picture — which is the obvious reading if you have only
 * ever seen single-slice streams — splits one picture into several access units. Each
 * fragment then carries its own timestamp and its own RTP marker bit, and the decoder is
 * handed partial pictures.
 *
 * Emulation prevention bytes are not stripped. They require a `00 00 03` sequence, which
 * cannot occur this early in a slice header for any real stream.
 */
export function firstMacroblockInSlice(nal: Buffer): number | null {
  if (nal.length < 2) {
    return null
  }

  return readUnsignedExpGolomb(nal, 8)
}
