import { describe, expect, it } from 'vitest'

import { H264Packetizer, RTP_HEADER_SIZE, maxPayloadSize, readRtpHeader } from './h264-packetizer.js'

const PAYLOAD_TYPE = 99
const SSRC = 0x1234abcd

function packetizer(over: Partial<{ initialSequence: number, maxPayloadSize: number }> = {}): H264Packetizer {
  return new H264Packetizer({
    initialSequence: over.initialSequence ?? 1000,
    maxPayloadSize: over.maxPayloadSize ?? 1300,
    payloadType: PAYLOAD_TYPE,
    ssrc: SSRC,
  })
}

/** A NAL unit of `length` bytes with the given first byte. */
function nal(header: number, length: number): Buffer {
  const buffer = Buffer.alloc(length, 0xab)

  buffer.writeUInt8(header, 0)

  return buffer
}

describe('maxPayloadSize', () => {
  it('reserves room for the RTP header and the SRTP auth tag', () => {
    // HomeKit's IPv4 default MTU.
    expect(maxPayloadSize(1378)).toBe(1378 - 12 - 10)
  })
})

describe('single NAL unit packets', () => {
  it('sends a NAL that fits as one packet, unmodified', () => {
    const slice = nal(0x65, 100)
    const packets = packetizer().packetizeAccessUnit([slice], 90_000)

    expect(packets).toHaveLength(1)
    expect(packets[0]?.subarray(RTP_HEADER_SIZE).equals(slice)).toBe(true)
  })

  it('writes version 2 and the negotiated payload type, SSRC and timestamp', () => {
    const packets = packetizer().packetizeAccessUnit([nal(0x65, 100)], 123_456)
    const header = readRtpHeader(packets[0]!)

    expect(packets[0]?.readUInt8(0)).toBe(0x80)
    expect(header.payloadType).toBe(PAYLOAD_TYPE)
    expect(header.ssrc).toBe(SSRC)
    expect(header.timestamp).toBe(123_456)
  })

  it('increments the sequence number per packet', () => {
    const packets = packetizer({ initialSequence: 65_534 })
      .packetizeAccessUnit([nal(0x67, 10), nal(0x68, 10), nal(0x65, 10)], 0)

    expect(packets.map(p => readRtpHeader(p).sequence)).toEqual([65_534, 65_535, 0])
  })

  it('skips empty NAL units', () => {
    expect(packetizer().packetizeAccessUnit([Buffer.alloc(0), nal(0x65, 10)], 0)).toHaveLength(1)
  })
})

describe('the marker bit', () => {
  it('is set only on the last packet of an access unit', () => {
    const packets = packetizer().packetizeAccessUnit([nal(0x67, 10), nal(0x68, 10), nal(0x65, 10)], 0)

    expect(packets.map(p => readRtpHeader(p).marker)).toEqual([false, false, true])
  })

  it('is set on the last fragment when the final NAL is fragmented', () => {
    const packets = packetizer({ maxPayloadSize: 50 }).packetizeAccessUnit([nal(0x65, 300)], 0)
    const markers = packets.map(p => readRtpHeader(p).marker)

    expect(markers.slice(0, -1).every(m => !m)).toBe(true)
    expect(markers.at(-1)).toBe(true)
  })
})

describe('FU-A fragmentation', () => {
  it('splits an oversized NAL and rebuilds it byte for byte', () => {
    const slice = nal(0x65, 500)
    const packets = packetizer({ maxPayloadSize: 100 }).packetizeAccessUnit([slice], 0)

    expect(packets.length).toBeGreaterThan(1)

    // Reassemble: original header byte, then each fragment's payload past the two FU bytes.
    const body = Buffer.concat(packets.map(p => p.subarray(RTP_HEADER_SIZE + 2)))

    expect(Buffer.concat([Buffer.from([0x65]), body]).equals(slice)).toBe(true)
  })

  it('preserves nal_ref_idc and carries type 28 in the indicator', () => {
    const packets = packetizer({ maxPayloadSize: 100 }).packetizeAccessUnit([nal(0x65, 500)], 0)
    const indicator = packets[0]!.readUInt8(RTP_HEADER_SIZE)

    expect(indicator & 0x1f).toBe(28)
    expect(indicator & 0xe0).toBe(0x60)
  })

  it('marks the first and last fragments and no others', () => {
    const packets = packetizer({ maxPayloadSize: 100 }).packetizeAccessUnit([nal(0x65, 500)], 0)
    const fuHeaders = packets.map(p => p.readUInt8(RTP_HEADER_SIZE + 1))

    expect((fuHeaders[0]! & 0x80) !== 0).toBe(true)
    expect((fuHeaders[0]! & 0x40) !== 0).toBe(false)
    expect((fuHeaders.at(-1)! & 0x40) !== 0).toBe(true)
    expect((fuHeaders.at(-1)! & 0x80) !== 0).toBe(false)

    for (const header of fuHeaders.slice(1, -1)) {
      expect(header & 0xc0).toBe(0)
    }
  })

  it('carries the original NAL type in every fragment header', () => {
    const packets = packetizer({ maxPayloadSize: 100 }).packetizeAccessUnit([nal(0x65, 500)], 0)

    for (const packet of packets) {
      expect(packet.readUInt8(RTP_HEADER_SIZE + 1) & 0x1f).toBe(5)
    }
  })

  it('never exceeds the payload budget', () => {
    const budget = 100
    const packets = packetizer({ maxPayloadSize: budget }).packetizeAccessUnit([nal(0x65, 5000)], 0)

    for (const packet of packets) {
      expect(packet.length - RTP_HEADER_SIZE).toBeLessThanOrEqual(budget)
    }
  })

  it('shares one timestamp across every packet of an access unit', () => {
    const packets = packetizer({ maxPayloadSize: 100 })
      .packetizeAccessUnit([nal(0x67, 20), nal(0x65, 500)], 90_000)

    expect(new Set(packets.map(p => readRtpHeader(p).timestamp))).toEqual(new Set([90_000]))
  })
})

describe('construction', () => {
  it('rejects a payload budget that cannot fit a header', () => {
    expect(() => new H264Packetizer({ maxPayloadSize: 8, payloadType: 99, ssrc: 1 })).toThrow(/maxPayloadSize/)
  })

  it('accepts an SSRC with the high bit set', () => {
    const packets = new H264Packetizer({ maxPayloadSize: 1300, payloadType: 99, ssrc: 0xffffffff })
      .packetizeAccessUnit([nal(0x65, 10)], 0)

    expect(readRtpHeader(packets[0]!).ssrc).toBe(0xffffffff)
  })
})
