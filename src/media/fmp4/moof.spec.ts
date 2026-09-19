import { describe, expect, it } from 'vitest'

import { parseMoof, readBaseMediaDecodeTime, readVideoTrackId } from './moof.js'

function box(type: string, body: Uint8Array): Buffer {
  const header = Buffer.alloc(8)

  header.writeUInt32BE(8 + body.length, 0)
  header.write(type, 4, 'latin1')

  return Buffer.concat([header, body])
}

function u32(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4)

  values.forEach((value, index) => { buffer.writeUInt32BE(value, index * 4) })

  return buffer
}

/** tfhd carrying only a track id (flags 0). */
function tfhd(trackId: number, flags = 0, extra: Uint8Array = Buffer.alloc(0)): Buffer {
  return box('tfhd', Buffer.concat([Buffer.from([0, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), u32(trackId), extra]))
}

/** trun with data-offset and sample-size present (flags 0x201). */
function trun(dataOffset: number, sizes: number[]): Buffer {
  return box('trun', Buffer.concat([
    Buffer.from([0, 0x00, 0x02, 0x01]),
    u32(sizes.length, dataOffset),
    u32(...sizes),
  ]))
}

describe('parseMoof', () => {
  it('sums one track\'s sample sizes and reports its data offset', () => {
    const moof = box('moof', Buffer.concat([
      box('mfhd', u32(0, 1)),
      box('traf', Buffer.concat([tfhd(1), trun(248, [100, 200, 300])])),
    ]))

    const runs = parseMoof(moof)

    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual({
      compositionOffsets: [], dataOffset: 248, defaultSampleDuration: 0, durations: [],
      sampleCount: 3, totalBytes: 600, trackId: 1,
    })
  })

  it('separates video from audio, which is the whole point', () => {
    // Protect puts both tracks in one mdat; without this the NAL walk reads AAC as video.
    const moof = box('moof', Buffer.concat([
      box('mfhd', u32(0, 1)),
      box('traf', Buffer.concat([tfhd(1), trun(300, [1000, 1000, 1000])])),
      box('traf', Buffer.concat([tfhd(2), trun(3300, [200, 200])])),
    ]))

    const runs = parseMoof(moof)

    expect(runs.map(r => r.trackId)).toEqual([1, 2])
    expect(runs.find(r => r.trackId === 1)?.totalBytes).toBe(3000)
    expect(runs.find(r => r.trackId === 2)?.totalBytes).toBe(400)
  })

  it('falls back to the tfhd default sample size when trun omits sizes', () => {
    // flags 0x10 = default-sample-size-present; trun flags 0x101 = data-offset + duration.
    const runWithDurations = box('trun', Buffer.concat([
      Buffer.from([0, 0x00, 0x01, 0x01]),
      u32(3, 500),
      u32(10, 10, 10),
    ]))
    const moof = box('moof', box('traf', Buffer.concat([tfhd(1, 0x10, u32(250)), runWithDurations])))

    expect(parseMoof(moof)[0]).toMatchObject({ sampleCount: 3, totalBytes: 750 })
  })

  it('skips the optional tfhd fields that precede the default size', () => {
    // flags 0x19 = base-data-offset (8 bytes) + default-duration (4) + default-size (4).
    const extra = Buffer.concat([Buffer.alloc(8), u32(3000), u32(77)])
    const moof = box('moof', box('traf', Buffer.concat([
      tfhd(7, 0x19, extra),
      box('trun', Buffer.concat([Buffer.from([0, 0x00, 0x00, 0x01]), u32(2, 100)])),
    ])))

    expect(parseMoof(moof)[0]).toEqual({
      compositionOffsets: [], dataOffset: 100, defaultSampleDuration: 3000, durations: [],
      sampleCount: 2, totalBytes: 154, trackId: 7,
    })
  })

  it('returns nothing for a moof with no track fragments', () => {
    expect(parseMoof(box('moof', box('mfhd', u32(0, 1))))).toEqual([])
  })

  it('tolerates a truncated trun rather than throwing', () => {
    const truncated = box('trun', Buffer.concat([Buffer.from([0, 0x00, 0x02, 0x01]), u32(9, 0), u32(10)]))

    expect(() => parseMoof(box('moof', box('traf', Buffer.concat([tfhd(1), truncated]))))).not.toThrow()
  })
})

describe('readVideoTrackId', () => {
  function trak(trackId: number, sampleEntry: string): Buffer {
    const tkhd = box('tkhd', Buffer.concat([Buffer.from([0, 0, 0, 0]), u32(0, 0, trackId)]))
    const entry = box(sampleEntry, Buffer.alloc(78))
    const stsd = box('stsd', Buffer.concat([Buffer.alloc(8), entry]))

    return box('trak', Buffer.concat([tkhd, box('mdia', box('minf', box('stbl', stsd)))]))
  }

  it('picks the H.264 track, not the audio track', () => {
    const moov = box('moov', Buffer.concat([trak(2, 'mp4a'), trak(1, 'avc1')]))

    expect(readVideoTrackId(moov)).toBe(1)
  })

  it('reads a version-1 tkhd, where the id sits further in', () => {
    const tkhd = box('tkhd', Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.alloc(16), u32(9)]))
    const entry = box('avc1', Buffer.alloc(78))
    const stsd = box('stsd', Buffer.concat([Buffer.alloc(8), entry]))
    const moov = box('moov', box('trak', Buffer.concat([tkhd, box('mdia', box('minf', box('stbl', stsd)))])))

    expect(readVideoTrackId(moov)).toBe(9)
  })

  it('returns null when there is no video track', () => {
    expect(readVideoTrackId(box('moov', trak(2, 'mp4a')))).toBeNull()
    expect(readVideoTrackId(box('ftyp', Buffer.from('isom')))).toBeNull()
  })
})

describe('composition time offsets', () => {
  /** trun with data-offset, sample-size and composition-offset present (flags 0xa01). */
  function trunWithComposition(version: number, sizes: number[], offsets: number[]): Buffer {
    const perSample = Buffer.concat(sizes.map((size, index) => {
      const entry = Buffer.alloc(8)

      entry.writeUInt32BE(size, 0)

      if (version === 0) {
        entry.writeUInt32BE(offsets[index] ?? 0, 4)
      } else {
        entry.writeInt32BE(offsets[index] ?? 0, 4)
      }

      return entry
    }))

    return box('trun', Buffer.concat([
      Buffer.from([version, 0x00, 0x0a, 0x01]),
      u32(sizes.length, 200),
      perSample,
    ]))
  }

  it('reads offsets, which is what distinguishes presentation order from decode order', () => {
    // Without these, a B-frame stream plays pictures out of sequence: static areas stay
    // sharp while anything moving smears.
    const moof = box('moof', box('traf', Buffer.concat([tfhd(1), trunWithComposition(0, [10, 20, 30], [0, 6000, 3000])])))

    expect(parseMoof(moof)[0]?.compositionOffsets).toEqual([0, 6000, 3000])
  })

  it('reads version 1 offsets as signed, so presentation may precede decode', () => {
    const moof = box('moof', box('traf', Buffer.concat([tfhd(1), trunWithComposition(1, [10, 20], [-3000, 3000])])))

    expect(parseMoof(moof)[0]?.compositionOffsets).toEqual([-3000, 3000])
  })

  it('still sums sample sizes correctly alongside the offsets', () => {
    const moof = box('moof', box('traf', Buffer.concat([tfhd(1), trunWithComposition(0, [10, 20, 30], [0, 0, 0])])))

    expect(parseMoof(moof)[0]?.totalBytes).toBe(60)
  })

  it('reports no offsets when the trun omits them', () => {
    const moof = box('moof', box('traf', Buffer.concat([tfhd(1), trun(248, [100, 200])])))

    expect(parseMoof(moof)[0]?.compositionOffsets).toEqual([])
  })
})

describe('readBaseMediaDecodeTime', () => {
  // tfhd needs flags with neither base-data-offset nor default-sample-size set, so the
  // parser reads the track id and stops.
  function tfhd(trackId: number): Buffer {
    return box('tfhd', u32(0, trackId))
  }

  function traf(trackId: number, tfdt: Buffer): Buffer {
    return box('traf', Buffer.concat([tfhd(trackId), tfdt]))
  }

  it('reads a 32-bit base media decode time', () => {
    const tfdt = box('tfdt', u32(0, 1_234_567))
    const moof = box('moof', traf(1, tfdt))

    expect(readBaseMediaDecodeTime(moof, 1)).toBe(1_234_567)
  })

  it('reads a 64-bit base media decode time', () => {
    const body = Buffer.alloc(12)

    body.writeUInt8(1, 0)
    body.writeBigUInt64BE(9_007_199_254n, 4)

    const moof = box('moof', traf(2, box('tfdt', body)))

    expect(readBaseMediaDecodeTime(moof, 2)).toBe(9_007_199_254)
  })

  it('returns the requested track, not the first one', () => {
    // Protect puts audio and video in one fragment, and not in the order a reader expects.
    const audio = traf(1, box('tfdt', u32(0, 500)))
    const video = traf(2, box('tfdt', u32(0, 9000)))
    const moof = box('moof', Buffer.concat([audio, video]))

    expect(readBaseMediaDecodeTime(moof, 2)).toBe(9000)
    expect(readBaseMediaDecodeTime(moof, 1)).toBe(500)
  })

  it('returns null when the track has no tfdt, rather than guessing', () => {
    const moof = box('moof', box('traf', tfhd(1)))

    expect(readBaseMediaDecodeTime(moof, 1)).toBeNull()
    expect(readBaseMediaDecodeTime(moof, 99)).toBeNull()
  })
})

describe('per-sample durations', () => {
  // The interval between pictures is not the nominal one. A live G5 Bullet channel
  // configured at 30 fps was measured emitting 2999, 3049, 2951, 3000 on a 90 kHz
  // timescale. Spacing a fragment uniformly accumulates that error until the clock
  // overshoots the next fragment and steps backwards.
  it('reads the durations the trun states', () => {
    // flags 0x000301: data-offset, sample-duration, sample-size.
    const body = Buffer.concat([
      Buffer.from([0, 0x00, 0x03, 0x01]),
      u32(4, 0),
      u32(2999, 100), u32(3049, 100), u32(2951, 100), u32(3000, 100),
    ])
    const moof = box('moof', box('traf', Buffer.concat([box('tfhd', u32(0, 1)), box('trun', body)])))
    const run = parseMoof(moof)[0]

    expect(run?.durations).toEqual([2999, 3049, 2951, 3000])
    expect(run?.sampleCount).toBe(4)
    expect(run?.totalBytes).toBe(400)
  })

  it('falls back to the tfhd default when the trun omits durations', () => {
    // tfhd flags 0x000008 sets default_sample_duration; trun flags 0x000201 omit durations.
    const header = box('tfhd', Buffer.concat([Buffer.from([0, 0x00, 0x00, 0x08]), u32(1, 3000)]))
    const body = Buffer.concat([Buffer.from([0, 0x00, 0x02, 0x01]), u32(2, 0), u32(77), u32(77)])
    const run = parseMoof(box('moof', box('traf', Buffer.concat([header, box('trun', body)]))))[0]

    expect(run?.durations).toEqual([])
    expect(run?.defaultSampleDuration).toBe(3000)
  })
})
