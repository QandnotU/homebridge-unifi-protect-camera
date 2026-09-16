import type { AvcConfig } from './avcc.js'

import { describe, expect, it } from 'vitest'

import { applyTimestamps, splitAccessUnits, withParameterSets } from './demux.js'

const SPS = Buffer.from([0x67, 0x64, 0x00, 0x28])
const PPS = Buffer.from([0x68, 0xee, 0x3c])

const config: AvcConfig = {
  level: 40,
  nalLengthSize: 4,
  pps: [PPS],
  profile: 100,
  profileCompatibility: 0,
  sps: [SPS],
}

/** NAL unit with the given header byte, padded to a recognisable length. */
function nal(header: number, length = 8): Buffer {
  const buffer = Buffer.alloc(length, 0xcd)

  buffer.writeUInt8(header, 0)

  return buffer
}

/** A slice that begins a picture: `first_mb_in_slice` of zero. */
function firstSlice(header: number): Buffer {
  return Buffer.from([header, 0x80, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd])
}

/** A continuation slice of the same picture: `first_mb_in_slice` above zero. */
function continuationSlice(header: number): Buffer {
  return Buffer.from([header, 0x40, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd, 0xcd])
}

const IDR = nal(0x65)
const SLICE = nal(0x41)
const SEI = nal(0x06)
const AUD = nal(0x09)

/** Pack NAL units into an AVCC payload the way an mdat carries them. */
function mdat(nals: readonly Buffer[]): Buffer {
  return Buffer.concat(nals.flatMap(unit => {
    const prefix = Buffer.alloc(4)

    prefix.writeUInt32BE(unit.length, 0)

    return [prefix, unit]
  }))
}

describe('splitAccessUnits', () => {
  it('groups parameter sets and SEI with the picture that follows', () => {
    const units = splitAccessUnits(mdat([SPS, PPS, SEI, IDR]), config)

    expect(units).toHaveLength(1)
    expect(units[0]?.nals).toHaveLength(4)
    expect(units[0]?.keyframe).toBe(true)
  })

  it('starts a new unit at each subsequent coded slice', () => {
    const units = splitAccessUnits(mdat([IDR, SLICE, SLICE]), config)

    expect(units).toHaveLength(3)
    expect(units.map(u => u.keyframe)).toEqual([true, false, false])
  })

  it('starts a new unit at an access unit delimiter', () => {
    const units = splitAccessUnits(mdat([AUD, IDR, AUD, SLICE]), config)

    expect(units).toHaveLength(2)
    expect(units[0]?.nals).toHaveLength(2)
  })

  it('starts a new unit when parameter sets follow picture data', () => {
    // The second SPS belongs to the next picture, not the one just finished.
    const units = splitAccessUnits(mdat([SPS, PPS, IDR, SPS, PPS, SLICE]), config)

    expect(units).toHaveLength(2)
    expect(units[0]?.nals).toHaveLength(3)
    expect(units[1]?.nals).toHaveLength(3)
  })

  it('returns nothing for an empty payload', () => {
    expect(splitAccessUnits(Buffer.alloc(0), config)).toEqual([])
  })

  it('honours a two-byte length prefix', () => {
    const payload = Buffer.concat([Buffer.from([0x00, IDR.length]), IDR])

    expect(splitAccessUnits(payload, { ...config, nalLengthSize: 2 })).toHaveLength(1)
  })
})

describe('applyTimestamps', () => {
  const units = splitAccessUnits(mdat([IDR, SLICE, SLICE]), config)

  it('uses the controller\'s timestamps when the counts agree', () => {
    expect(applyTimestamps(units, [100, 200, 300], 0, 50).map(u => u.timestamp)).toEqual([100, 200, 300])
  })

  it('advances evenly when the counts disagree', () => {
    // Attaching mismatched timestamps to the wrong pictures is worse than a synthesized
    // but monotonic clock.
    expect(applyTimestamps(units, [100, 200], 0, 50).map(u => u.timestamp)).toEqual([100, 150, 200])
  })

  it('advances from the fallback when no timestamps arrive', () => {
    expect(applyTimestamps(units, undefined, 1000, 30).map(u => u.timestamp)).toEqual([1000, 1030, 1060])
  })

  it('always produces a monotonic sequence', () => {
    for (const supplied of [undefined, [5], [5, 6], [5, 6, 7]]) {
      const stamps = applyTimestamps(units, supplied, 0, 10).map(u => u.timestamp)

      expect(stamps.every((value, index) => (index === 0) || (value > (stamps[index - 1] ?? 0)))).toBe(true)
    }
  })

  it('handles an empty unit list', () => {
    expect(applyTimestamps([], [1, 2], 0, 10)).toEqual([])
  })
})

describe('withParameterSets', () => {
  it('prepends SPS and PPS to a keyframe that lacks them', () => {
    const [unit] = splitAccessUnits(mdat([IDR]), config)
    const patched = withParameterSets(unit!, config)

    expect(patched.nals).toHaveLength(3)
    expect(patched.nals[0]?.equals(SPS)).toBe(true)
    expect(patched.nals[1]?.equals(PPS)).toBe(true)
  })

  it('leaves a keyframe that already carries them alone', () => {
    const [unit] = splitAccessUnits(mdat([SPS, PPS, IDR]), config)

    expect(withParameterSets(unit!, config).nals).toHaveLength(3)
  })

  it('leaves non-keyframes alone', () => {
    // A client joining mid-stream needs parameter sets at the keyframe it resumes from;
    // repeating them on every picture would just waste bandwidth.
    const units = splitAccessUnits(mdat([IDR, SLICE]), config)

    expect(withParameterSets(units[1]!, config).nals).toHaveLength(1)
  })
})

describe('multi-slice pictures', () => {
  it('keeps the slices of one picture in a single access unit', () => {
    // The bug this guards: treating every coded slice as a new picture produced more
    // access units than the controller reported timestamps for, dropping the stream onto
    // approximate timing and handing the decoder fragments of pictures.
    const units = splitAccessUnits(mdat([firstSlice(0x65), continuationSlice(0x65), continuationSlice(0x65)]), config)

    expect(units).toHaveLength(1)
    expect(units[0]?.nals).toHaveLength(3)
    expect(units[0]?.keyframe).toBe(true)
  })

  it('starts a new access unit at the next picture\'s first slice', () => {
    const units = splitAccessUnits(mdat([
      firstSlice(0x65), continuationSlice(0x65),
      firstSlice(0x41), continuationSlice(0x41),
    ]), config)

    expect(units).toHaveLength(2)
    expect(units.map(u => u.nals.length)).toEqual([2, 2])
    expect(units.map(u => u.keyframe)).toEqual([true, false])
  })

  it('still splits single-slice pictures one per access unit', () => {
    const units = splitAccessUnits(mdat([firstSlice(0x65), firstSlice(0x41), firstSlice(0x41)]), config)

    expect(units).toHaveLength(3)
  })

  it('treats an unreadable slice header as a new picture, never merging two', () => {
    // Merging two pictures is the worse failure, so an unreadable header errs that way.
    const units = splitAccessUnits(mdat([firstSlice(0x65), Buffer.from([0x41])]), config)

    expect(units).toHaveLength(2)
  })
})
