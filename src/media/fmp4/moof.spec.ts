import { describe, expect, it } from 'vitest'

import { parseMoof, readVideoTrackId } from './moof.js'

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
    expect(runs[0]).toEqual({ dataOffset: 248, sampleCount: 3, totalBytes: 600, trackId: 1 })
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

    expect(parseMoof(moof)[0]).toEqual({ dataOffset: 100, sampleCount: 2, totalBytes: 154, trackId: 7 })
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
