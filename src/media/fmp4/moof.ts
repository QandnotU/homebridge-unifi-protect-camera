import { childrenOf, findBoxDeep, iterateBoxes } from './boxes.js'

/**
 * Where one track's samples live inside a media segment.
 *
 * Protect puts video and audio in a single `mdat`, so recovering the video bytes means
 * reading the sample table rather than walking the whole payload. Walking it blind reads
 * AAC as though it were length-prefixed H.264, which yields a spurious extra picture and
 * desynchronises the controller's decode timestamps.
 */
export interface TrackRun {
  readonly trackId: number
  /** Offset of this track's first sample, relative to the start of the `moof` box. */
  readonly dataOffset: number
  readonly totalBytes: number
  readonly sampleCount: number
  /**
   * Per-sample composition time offsets: presentation time minus decode time, in the
   * track's timescale.
   *
   * Non-zero only when the stream uses B-frames, where decode order differs from display
   * order. RTP timestamps must carry *presentation* time, so ignoring these plays pictures
   * in the wrong order — which looks like smearing on anything that moves while static
   * parts of the frame stay perfectly sharp.
   *
   * Empty when the `trun` omits them, which means every offset is zero.
   */
  readonly compositionOffsets: readonly number[]
}

const TFHD_BASE_DATA_OFFSET = 0x000001
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x000002
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010
// default_sample_flags (0x000020) would follow the size; nothing here reads it.

const TRUN_DATA_OFFSET = 0x000001
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004
const TRUN_SAMPLE_DURATION = 0x000100
const TRUN_SAMPLE_SIZE = 0x000200
const TRUN_SAMPLE_FLAGS = 0x000400
const TRUN_SAMPLE_COMPOSITION_OFFSET = 0x000800

interface Tfhd {
  readonly trackId: number
  readonly defaultSampleSize: number
}

function parseTfhd(body: Buffer): Tfhd | null {
  if (body.length < 8) {
    return null
  }

  const flags = body.readUIntBE(1, 3)
  const trackId = body.readUInt32BE(4)

  let offset = 8

  if (flags & TFHD_BASE_DATA_OFFSET) {
    offset += 8
  }

  if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) {
    offset += 4
  }

  if (flags & TFHD_DEFAULT_SAMPLE_DURATION) {
    offset += 4
  }

  let defaultSampleSize = 0

  if (flags & TFHD_DEFAULT_SAMPLE_SIZE) {
    if ((offset + 4) > body.length) {
      return null
    }

    defaultSampleSize = body.readUInt32BE(offset)
  }

  // `default_sample_flags` would follow, but nothing here needs it.

  return { defaultSampleSize, trackId }
}

interface TrunResult {
  dataOffset: number
  sampleCount: number
  totalBytes: number
  compositionOffsets: number[]
}

function parseTrun(body: Buffer, defaultSampleSize: number): TrunResult | null {
  if (body.length < 8) {
    return null
  }

  const flags = body.readUIntBE(1, 3)
  const sampleCount = body.readUInt32BE(4)

  let offset = 8
  let dataOffset = 0

  if (flags & TRUN_DATA_OFFSET) {
    if ((offset + 4) > body.length) {
      return null
    }

    dataOffset = body.readInt32BE(offset)
    offset += 4
  }

  if (flags & TRUN_FIRST_SAMPLE_FLAGS) {
    offset += 4
  }

  // Per-sample fields, in the order the specification fixes.
  const perSample = ((flags & TRUN_SAMPLE_DURATION) ? 4 : 0)
    + ((flags & TRUN_SAMPLE_SIZE) ? 4 : 0)
    + ((flags & TRUN_SAMPLE_FLAGS) ? 4 : 0)
    + ((flags & TRUN_SAMPLE_COMPOSITION_OFFSET) ? 4 : 0)

  // In trun version 0 the composition offset is unsigned; version 1 makes it signed, which
  // is how a stream signals that presentation can precede decode.
  const version = body.readUInt8(0)

  let totalBytes = 0
  const compositionOffsets: number[] = []

  for (let index = 0; index < sampleCount; index++) {
    const sizeOffset = offset + ((flags & TRUN_SAMPLE_DURATION) ? 4 : 0)

    if (flags & TRUN_SAMPLE_SIZE) {
      if ((sizeOffset + 4) > body.length) {
        return null
      }

      totalBytes += body.readUInt32BE(sizeOffset)
    } else {
      totalBytes += defaultSampleSize
    }

    if (flags & TRUN_SAMPLE_COMPOSITION_OFFSET) {
      const ctoOffset = offset + perSample - 4

      if ((ctoOffset + 4) > body.length) {
        return null
      }

      compositionOffsets.push((version === 0) ? body.readUInt32BE(ctoOffset) : body.readInt32BE(ctoOffset))
    }

    offset += perSample
  }

  return { compositionOffsets, dataOffset, sampleCount, totalBytes }
}

/** Read every track fragment in a `moof` box. */
export function parseMoof(moof: Buffer): TrackRun[] {
  const runs: TrackRun[] = []

  for (const box of iterateBoxes(moof)) {
    if (box.type !== 'moof') {
      continue
    }

    for (const traf of childrenOf(box)) {
      if (traf.type !== 'traf') {
        continue
      }

      let header: Tfhd | null = null

      for (const child of childrenOf(traf)) {
        if (child.type === 'tfhd') {
          header = parseTfhd(child.body)
        }

        if ((child.type === 'trun') && header) {
          const run = parseTrun(child.body, header.defaultSampleSize)

          if (run) {
            runs.push({
              compositionOffsets: run.compositionOffsets,
              dataOffset: run.dataOffset,
              sampleCount: run.sampleCount,
              totalBytes: run.totalBytes,
              trackId: header.trackId,
            })
          }
        }
      }
    }
  }

  return runs
}

/**
 * The track id of the H.264 video track, read from the init segment.
 *
 * Found by locating the track whose sample description is `avc1` and reading its `tkhd`.
 */
export function readVideoTrackId(initSegment: Buffer): number | null {
  const moov = findBoxDeep(initSegment, 'moov')

  if (!moov) {
    return null
  }

  for (const trak of childrenOf(moov)) {
    if (trak.type !== 'trak') {
      continue
    }

    // Only consider a track that actually carries H.264.
    if (!findBoxDeep(trak.body, 'avc1') && !findBoxDeep(trak.body, 'avcC')) {
      continue
    }

    for (const child of childrenOf(trak)) {
      if (child.type !== 'tkhd') {
        continue
      }

      const version = child.body.readUInt8(0)
      const offset = (version === 1) ? 20 : 12

      if ((offset + 4) <= child.body.length) {
        return child.body.readUInt32BE(offset)
      }
    }
  }

  return null
}

/**
 * The `tfdt` base media decode time for one track, in the track's own timescale.
 *
 * This is the authoritative stream timeline. The `unifi-protect` session negotiates
 * `rebaseTimestampsToZero`, so it starts near zero and advances continuously for the life
 * of the connection — restarting only across a reconnect, which the library flags on the
 * segment as `discontinuity`.
 *
 * It is worth reading rather than inferring. The per-frame `timestamps` array describes
 * spacing *within* a segment correctly, but reconstructing a stream clock from it means
 * re-estimating the frame interval every fragment and accumulating whatever that estimate
 * gets wrong. `tfdt` states the answer outright.
 *
 * Returns null when the segment carries no `tfdt` for that track, which is legal — the box
 * is optional — so callers must be able to proceed without it.
 */
export function readBaseMediaDecodeTime(moof: Buffer, trackId: number): number | null {
  for (const box of iterateBoxes(moof)) {
    if (box.type !== 'moof') {
      continue
    }

    for (const traf of childrenOf(box)) {
      if (traf.type !== 'traf') {
        continue
      }

      let matched = false
      let decodeTime: number | null = null

      for (const child of childrenOf(traf)) {
        if (child.type === 'tfhd') {
          matched = (parseTfhd(child.body)?.trackId === trackId)
        }

        if ((child.type === 'tfdt') && (child.body.length >= 8)) {
          const version = child.body.readUInt8(0)

          // Version 1 widens the field to 64 bits. Rebasing to zero keeps it inside the
          // safe-integer range, so a Number is exact here.
          decodeTime = (version === 1)
            ? ((child.body.length >= 12) ? Number(child.body.readBigUInt64BE(4)) : null)
            : child.body.readUInt32BE(4)
        }
      }

      if (matched && (decodeTime !== null)) {
        return decodeTime
      }
    }
  }

  return null
}
