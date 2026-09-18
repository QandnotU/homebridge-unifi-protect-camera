import { describe, expect, it } from 'vitest'

import { SrtcpSession, parseReceiverReports } from './srtcp.js'

const masterKey = Buffer.from('E1F97A0D3E018BE0D64FA32C06DE4139', 'hex')
const masterSalt = Buffer.from('0EC675AD498AFEEBB6960B3AABE6', 'hex')

/** A receiver report describing one source. */
function receiverReport(options: {
  cumulativeLost: number
  fractionLost: number
  jitter: number
  reporter: number
  source: number
}): Buffer {
  const packet = Buffer.alloc(32)

  packet.writeUInt8(0x80 | 1, 0)
  packet.writeUInt8(201, 1)
  packet.writeUInt16BE((32 / 4) - 1, 2)
  packet.writeUInt32BE(options.reporter, 4)
  packet.writeUInt32BE(options.source, 8)
  // Fraction lost and 24-bit cumulative lost share one word.
  packet.writeUInt32BE((((options.fractionLost & 0xff) << 24) | (options.cumulativeLost & 0xffffff)) >>> 0, 12)
  packet.writeUInt32BE(12_345, 16)
  packet.writeUInt32BE(options.jitter, 20)

  return packet
}

describe('parseReceiverReports', () => {
  it('reads loss and jitter from a receiver report', () => {
    const packet = receiverReport({ cumulativeLost: 42, fractionLost: 13, jitter: 900, reporter: 0xaaaa, source: 0xbbbb })
    const [report] = parseReceiverReports(packet)

    expect(report?.source).toBe(0xbbbb)
    expect(report?.cumulativeLost).toBe(42)
    expect(report?.jitter).toBe(900)
    // Fraction lost is 8-bit fixed point: 13/256 is about 5%.
    expect(report?.fractionLost).toBeCloseTo(13 / 256, 6)
  })

  it('reads a negative cumulative count, which duplicates can produce', () => {
    const packet = receiverReport({ cumulativeLost: -5 & 0xffffff, fractionLost: 0, jitter: 0, reporter: 1, source: 2 })

    expect(parseReceiverReports(packet)[0]?.cumulativeLost).toBe(-5)
  })

  it('finds report blocks that follow a sender report\'s sender info', () => {
    // A receiver that also sends may emit SR and RR together.
    const sr = Buffer.alloc(52)

    sr.writeUInt8(0x80 | 1, 0)
    sr.writeUInt8(200, 1)
    sr.writeUInt16BE((52 / 4) - 1, 2)
    sr.writeUInt32BE(0xcccc, 4)
    // 20 bytes of sender info, then the report block at offset 28.
    sr.writeUInt32BE(0xdddd, 28)
    sr.writeUInt32BE((7 << 24) | 99, 32)

    const [report] = parseReceiverReports(sr)

    expect(report?.source).toBe(0xdddd)
    expect(report?.cumulativeLost).toBe(99)
  })

  it('walks a compound packet and returns every block', () => {
    const first = receiverReport({ cumulativeLost: 1, fractionLost: 0, jitter: 0, reporter: 1, source: 10 })
    const second = receiverReport({ cumulativeLost: 2, fractionLost: 0, jitter: 0, reporter: 1, source: 20 })

    expect(parseReceiverReports(Buffer.concat([first, second])).map(r => r.source)).toEqual([10, 20])
  })

  it('ignores payload types that carry no report blocks', () => {
    const bye = Buffer.from([0x81, 203, 0x00, 0x01, 0, 0, 0, 1])

    expect(parseReceiverReports(bye)).toEqual([])
  })

  it('stops at a truncated or nonsensical packet rather than throwing', () => {
    expect(parseReceiverReports(Buffer.alloc(0))).toEqual([])
    expect(parseReceiverReports(Buffer.from([0x81, 201, 0xff, 0xff, 0, 0, 0, 1]))).toEqual([])
  })
})

describe('SrtcpSession round trip', () => {
  it('unprotects what it protected', () => {
    const session = new SrtcpSession(masterKey, masterSalt, 0x1234)
    const report = SrtcpSession.buildSenderReport({ octetCount: 2000, packetCount: 10, rtpTimestamp: 90_000, ssrc: 0x1234 })
    const recovered = session.unprotect(session.protect(report))

    expect(recovered?.equals(report)).toBe(true)
  })

  it('rejects a packet whose tag does not verify', () => {
    const session = new SrtcpSession(masterKey, masterSalt, 0x1234)
    const wire = session.protect(SrtcpSession.buildSenderReport({ octetCount: 1, packetCount: 1, rtpTimestamp: 0, ssrc: 0x1234 }))

    wire[12] = (wire[12] ?? 0) ^ 0x01
    expect(session.unprotect(wire)).toBeNull()
  })

  it('rejects a packet from a different key', () => {
    const mine = new SrtcpSession(masterKey, masterSalt, 0x1234)
    const theirs = new SrtcpSession(Buffer.alloc(16, 9), Buffer.alloc(14, 9), 0x1234)
    const wire = theirs.protect(SrtcpSession.buildSenderReport({ octetCount: 1, packetCount: 1, rtpTimestamp: 0, ssrc: 0x1234 }))

    expect(mine.unprotect(wire)).toBeNull()
  })

  it('reads a report the far end encrypted under its own SSRC', () => {
    // HomeKit sends from its own synchronisation source; the SSRC and index travel in the
    // clear, so the same master key decrypts it without knowing that source in advance.
    const remote = new SrtcpSession(masterKey, masterSalt, 0xfeedface)
    const local = new SrtcpSession(masterKey, masterSalt, 0x1234)
    const report = receiverReport({ cumulativeLost: 17, fractionLost: 5, jitter: 40, reporter: 0xfeedface, source: 0x1234 })

    const recovered = local.unprotect(remote.protect(report))

    expect(recovered).not.toBeNull()
    expect(parseReceiverReports(recovered!)[0]).toMatchObject({ cumulativeLost: 17, source: 0x1234 })
  })

  it('rejects anything too short to be SRTCP', () => {
    expect(new SrtcpSession(masterKey, masterSalt, 1).unprotect(Buffer.alloc(10))).toBeNull()
  })
})
