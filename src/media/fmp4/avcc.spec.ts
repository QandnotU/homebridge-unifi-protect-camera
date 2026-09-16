import { describe, expect, it } from 'vitest'

import {
  formatLevel, formatProfile, isKeyframe, isParameterSet, iterateNalUnits,
  macroblocks, minimumLevelFor, nalType, parseAvcC, readAvcConfig, toAnnexB,
} from './avcc.js'

/** Build an ISO BMFF box around a body. */
function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8)

  header.writeUInt32BE(8 + body.length, 0)
  header.write(type, 4, 'latin1')

  return Buffer.concat([header, body])
}

const SPS = Buffer.from([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9])
const PPS = Buffer.from([0x68, 0xee, 0x3c, 0xb0])

/** A well-formed AVCDecoderConfigurationRecord: High profile, level 4.0, 4-byte prefixes. */
function avcCBody(): Buffer {
  return Buffer.concat([
    Buffer.from([0x01, 100, 0x00, 40, 0xff, 0xe1]),
    Buffer.from([(SPS.length >> 8) & 0xff, SPS.length & 0xff]), SPS,
    Buffer.from([0x01]),
    Buffer.from([(PPS.length >> 8) & 0xff, PPS.length & 0xff]), PPS,
  ])
}

/** An init segment with the real nesting a Protect stream produces. */
function initSegment(): Buffer {
  const avcC = box('avcC', avcCBody())
  // A visual sample entry carries 78 bytes of fixed fields before its children.
  const avc1 = box('avc1', Buffer.concat([Buffer.alloc(78), avcC]))
  // stsd is a FullBox plus a 4-byte entry count.
  const stsd = box('stsd', Buffer.concat([Buffer.alloc(8), avc1]))

  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd))))),
  ])
}

describe('parseAvcC', () => {
  it('reads profile, level, prefix size and parameter sets', () => {
    const config = parseAvcC(avcCBody())

    expect(config).not.toBeNull()
    expect(config?.profile).toBe(100)
    expect(config?.level).toBe(40)
    expect(config?.nalLengthSize).toBe(4)
    expect(config?.sps).toHaveLength(1)
    expect(config?.pps).toHaveLength(1)
    expect(config?.sps[0]?.equals(SPS)).toBe(true)
    expect(config?.pps[0]?.equals(PPS)).toBe(true)
  })

  it('returns null for a truncated record rather than throwing', () => {
    const full = avcCBody()

    expect(parseAvcC(full.subarray(0, 3))).toBeNull()
    expect(parseAvcC(full.subarray(0, 9))).toBeNull()
    expect(parseAvcC(Buffer.alloc(0))).toBeNull()
  })

  it('reads a two-byte length prefix', () => {
    const body = avcCBody()

    // lengthSizeMinusOne lives in the low two bits of byte 4.
    body.writeUInt8(0xfd, 4)
    expect(parseAvcC(body)?.nalLengthSize).toBe(2)
  })
})

describe('readAvcConfig', () => {
  it('finds avcC through the full moov nesting', () => {
    const config = readAvcConfig(initSegment())

    expect(config?.level).toBe(40)
    expect(config?.sps[0]?.equals(SPS)).toBe(true)
  })

  it('returns null when there is no avcC', () => {
    expect(readAvcConfig(box('ftyp', Buffer.from('isom')))).toBeNull()
  })
})

describe('iterateNalUnits', () => {
  function avcc(nals: readonly Buffer[]): Buffer {
    return Buffer.concat(nals.flatMap(nal => {
      const prefix = Buffer.alloc(4)

      prefix.writeUInt32BE(nal.length, 0)

      return [prefix, nal]
    }))
  }

  it('recovers length-prefixed NAL units without parsing trun', () => {
    const slice = Buffer.from([0x65, 0xaa, 0xbb])
    const units = [...iterateNalUnits(avcc([SPS, PPS, slice]), 4)]

    expect(units).toHaveLength(3)
    expect(units[0]?.equals(SPS)).toBe(true)
    expect(units[2]?.equals(slice)).toBe(true)
  })

  it('stops at a prefix that overruns the buffer', () => {
    const payload = Buffer.concat([avcc([SPS]), Buffer.from([0x00, 0x00, 0xff, 0xff, 0x01])])

    expect([...iterateNalUnits(payload, 4)]).toHaveLength(1)
  })

  it('stops on a zero-length prefix', () => {
    expect([...iterateNalUnits(Buffer.from([0, 0, 0, 0, 0x65]), 4)]).toHaveLength(0)
  })

  it('handles an empty payload', () => {
    expect([...iterateNalUnits(Buffer.alloc(0), 4)]).toHaveLength(0)
  })
})

describe('NAL classification', () => {
  it('reads the type from the low five bits', () => {
    expect(nalType(SPS)).toBe(7)
    expect(nalType(PPS)).toBe(8)
    expect(nalType(Buffer.from([0x65]))).toBe(5)
    expect(nalType(Buffer.from([0x41]))).toBe(1)
  })

  it('identifies parameter sets and keyframes', () => {
    expect(isParameterSet(SPS)).toBe(true)
    expect(isParameterSet(PPS)).toBe(true)
    expect(isParameterSet(Buffer.from([0x65]))).toBe(false)
    expect(isKeyframe(Buffer.from([0x65]))).toBe(true)
    expect(isKeyframe(Buffer.from([0x41]))).toBe(false)
  })
})

describe('toAnnexB', () => {
  it('prefixes each NAL unit with a start code', () => {
    const out = toAnnexB([SPS, PPS])

    expect(out.subarray(0, 4).equals(Buffer.from([0, 0, 0, 1]))).toBe(true)
    expect(out.subarray(4, 4 + SPS.length).equals(SPS)).toBe(true)
    expect(out.subarray(4 + SPS.length, 8 + SPS.length).equals(Buffer.from([0, 0, 0, 1]))).toBe(true)
  })

  it('returns an empty buffer for no input', () => {
    expect(toAnnexB([]).length).toBe(0)
  })
})

describe('H.264 level requirements', () => {
  it('counts macroblocks with partial rows rounded up', () => {
    // 1080 is 67.5 macroblock rows, which costs 68.
    expect(macroblocks(1920, 1080)).toBe(8160)
    expect(macroblocks(1280, 720)).toBe(3600)
    expect(macroblocks(2688, 1512)).toBe(15960)
  })

  it('shows why the classic HomeKit path stops at 1080p', () => {
    // Level 4.0 is the highest HAP-NodeJS advertises, and its MaxFS of 8192 macroblocks
    // admits 1920x1080 at 8160 — with 32 to spare — and nothing larger.
    expect(minimumLevelFor(1920, 1080)).toBe(40)
    expect(minimumLevelFor(1280, 720)).toBe(31)

    // Every resolution above 1080p needs a level the classic path cannot advertise.
    expect(minimumLevelFor(2560, 1440)).toBe(50)
    expect(minimumLevelFor(2688, 1512)).toBe(50)
    expect(minimumLevelFor(3840, 2160)).toBe(51)
  })

  it('returns null when no defined level is large enough', () => {
    expect(minimumLevelFor(16384, 16384)).toBeNull()
  })
})

describe('formatting', () => {
  it('formats levels and profiles for humans', () => {
    expect(formatLevel(40)).toBe('4.0')
    expect(formatLevel(31)).toBe('3.1')
    expect(formatLevel(51)).toBe('5.1')
    expect(formatProfile(66)).toBe('Baseline')
    expect(formatProfile(77)).toBe('Main')
    expect(formatProfile(100)).toBe('High')
    expect(formatProfile(244)).toBe('profile 244')
  })
})
