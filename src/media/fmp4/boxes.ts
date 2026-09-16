/**
 * Minimal ISO base media file format (ISO/IEC 14496-12) box reader.
 *
 * Only what the video path needs: walking a box tree and reaching the codec
 * configuration inside an init segment. This is not a general MP4 parser, and it
 * deliberately never allocates — every box body is a subarray view over the caller's
 * buffer.
 */

/** Bytes in a plain box header: 32-bit size plus a four-character type. */
const HEADER_SIZE = 8

/** A 64-bit `largesize` follows the header when `size` is 1. */
const LARGE_SIZE_BYTES = 8

/** A `uuid` box carries a 16-byte extended type after the header. */
const EXTENDED_TYPE_BYTES = 16

/**
 * Offsets at which a container's children begin, measured from the start of its body.
 *
 * Most containers hold children immediately. The exceptions carry fixed fields first, and
 * skipping them is the difference between finding `avcC` and reading noise:
 *
 * - `stsd` is a FullBox (4 bytes of version and flags) plus a 4-byte entry count.
 * - A visual sample entry (`avc1`, `hvc1`, …) carries the 78-byte `VisualSampleEntry`
 *   record — resolution, frame count, compressor name — before its child boxes.
 */
const CHILD_OFFSETS: Readonly<Record<string, number>> = {
  avc1: 78,
  encv: 78,
  hev1: 78,
  hvc1: 78,
  stsd: 8,
}

export interface Box {
  readonly type: string
  /** Offset of the box header within the buffer it was read from. */
  readonly start: number
  /** Total size of the box including its header. */
  readonly size: number
  /** The box payload, as a view over the source buffer. */
  readonly body: Buffer
}

/**
 * Walk the boxes in `buffer` between `start` and `end`.
 *
 * Stops cleanly at the first malformed or truncated box rather than throwing: a live
 * stream can hand us a partial segment, and a demuxer that throws on one takes the whole
 * session down with it.
 */
export function* iterateBoxes(buffer: Buffer, start = 0, end = buffer.length): Generator<Box> {
  let offset = start

  while ((offset + HEADER_SIZE) <= end) {
    const declared = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + HEADER_SIZE)

    let headerSize = HEADER_SIZE
    let size = declared

    if (declared === 1) {
      if ((offset + HEADER_SIZE + LARGE_SIZE_BYTES) > end) {
        return
      }

      const large = buffer.readBigUInt64BE(offset + HEADER_SIZE)

      // Beyond Number.MAX_SAFE_INTEGER we cannot index the buffer anyway.
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
        return
      }

      size = Number(large)
      headerSize += LARGE_SIZE_BYTES
    } else if (declared === 0) {
      // "To the end of the enclosing container", per the specification.
      size = end - offset
    }

    if (type === 'uuid') {
      headerSize += EXTENDED_TYPE_BYTES
    }

    if ((size < headerSize) || ((offset + size) > end)) {
      return
    }

    yield { body: buffer.subarray(offset + headerSize, offset + size), size, start: offset, type }

    offset += size
  }
}

/** The direct children of a container box, accounting for any fixed fields it carries. */
export function childrenOf(box: Box): Generator<Box> {
  return iterateBoxes(box.body, CHILD_OFFSETS[box.type] ?? 0, box.body.length)
}

/**
 * Resolve a box path, e.g. `['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd', 'avc1', 'avcC']`.
 *
 * Returns the first match at each level, which is what we want for a single-track camera
 * stream. Returns null if any level is missing.
 */
export function findBox(buffer: Buffer, path: readonly string[]): Box | null {
  const [head, ...rest] = path

  if (head === undefined) {
    return null
  }

  for (const box of iterateBoxes(buffer)) {
    if (box.type !== head) {
      continue
    }

    if (rest.length === 0) {
      return box
    }

    const nested = findBoxIn(box, rest)

    if (nested) {
      return nested
    }
  }

  return null
}

function findBoxIn(parent: Box, path: readonly string[]): Box | null {
  const [head, ...rest] = path

  if (head === undefined) {
    return null
  }

  for (const child of childrenOf(parent)) {
    if (child.type !== head) {
      continue
    }

    if (rest.length === 0) {
      return child
    }

    const nested = findBoxIn(child, rest)

    if (nested) {
      return nested
    }
  }

  return null
}

/**
 * Find a box by type anywhere in the tree, breadth-first.
 *
 * Used when the exact path varies — `avcC` can sit under `avc1` or under a protection
 * scheme's `encv` — and we only care that there is exactly one video track.
 */
export function findBoxDeep(buffer: Buffer, type: string): Box | null {
  let frontier = [...iterateBoxes(buffer)]

  while (frontier.length > 0) {
    const next: Box[] = []

    for (const box of frontier) {
      if (box.type === type) {
        return box
      }

      next.push(...childrenOf(box))
    }

    frontier = next
  }

  return null
}
