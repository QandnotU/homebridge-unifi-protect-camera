import { describe, expect, it } from 'vitest'

import { SrtpSession, deriveKey, deriveSessionKeys, verifyAuthTag } from './srtp.js'
import { RTP_HEADER_SIZE, SRTP_AUTH_TAG_SIZE } from './h264-packetizer.js'

const hex = (value: string): Buffer => Buffer.from(value.replace(/\s/g, ''), 'hex')

/**
 * RFC 3711 Appendix B.3, verbatim. These are the authoritative vectors for the default
 * key derivation function; without them a round-trip test only proves we are consistent
 * with ourselves.
 */
const RFC = {
  authKey94: hex(`CEBE321F6FF7716B6FD4AB49AF256A15
                  6D38BAA48F0A0ACF3C34E2359E6CDBCE
                  E049646C43D9327AD175578EF7227098
                  6371C10C9A369AC2F94A8C5FBCDDDC25
                  6D6E919A48B610EF17C2041E47403576
                  6B68642C59BBFC2F34DB60DBDFB2`),
  cipherKey: hex('C61E7A93744F39EE10734AFE3FF7A087'),
  cipherSalt: hex('30CBBC08863D8C85D49DB34A9AE1'),
  masterKey: hex('E1F97A0D3E018BE0D64FA32C06DE4139'),
  masterSalt: hex('0EC675AD498AFEEBB6960B3AABE6'),
}

describe('key derivation (RFC 3711 B.3)', () => {
  it('derives the cipher key', () => {
    expect(deriveKey(RFC.masterKey, RFC.masterSalt, 0x00, 16).toString('hex'))
      .toBe(RFC.cipherKey.toString('hex'))
  })

  it('derives the cipher salt', () => {
    expect(deriveKey(RFC.masterKey, RFC.masterSalt, 0x02, 14).toString('hex'))
      .toBe(RFC.cipherSalt.toString('hex'))
  })

  it('derives the authentication key, all 94 octets', () => {
    // 94 bytes spans six AES blocks, so this also proves the counter advances correctly
    // across block boundaries.
    expect(deriveKey(RFC.masterKey, RFC.masterSalt, 0x01, 94).toString('hex'))
      .toBe(RFC.authKey94.toString('hex'))
  })

  it('uses the first 20 octets of the auth key for HMAC-SHA1', () => {
    const keys = deriveSessionKeys(RFC.masterKey, RFC.masterSalt)

    expect(keys.authKey.toString('hex')).toBe(RFC.authKey94.subarray(0, 20).toString('hex'))
    expect(keys.encryptionKey.toString('hex')).toBe(RFC.cipherKey.toString('hex'))
    expect(keys.salt.toString('hex')).toBe(RFC.cipherSalt.toString('hex'))
  })
})

/** An RTP packet with the given sequence number and a recognisable payload. */
function rtpPacket(sequence: number, ssrc = 0xdeadbeef, payloadLength = 40): Buffer {
  const packet = Buffer.alloc(RTP_HEADER_SIZE + payloadLength)

  packet.writeUInt8(0x80, 0)
  packet.writeUInt8(99, 1)
  packet.writeUInt16BE(sequence, 2)
  packet.writeUInt32BE(0x11223344, 4)
  packet.writeUInt32BE(ssrc, 8)
  packet.fill(0x5a, RTP_HEADER_SIZE)

  return packet
}

describe('SrtpSession', () => {
  const masterKey = RFC.masterKey
  const masterSalt = RFC.masterSalt
  const ssrc = 0xdeadbeef

  it('rejects a wrong-sized key or salt', () => {
    expect(() => new SrtpSession(Buffer.alloc(15), masterSalt, ssrc)).toThrow(/master key/)
    expect(() => new SrtpSession(masterKey, Buffer.alloc(13), ssrc)).toThrow(/master salt/)
  })

  it('leaves the RTP header in the clear and encrypts only the payload', () => {
    const packet = rtpPacket(100)
    const out = new SrtpSession(masterKey, masterSalt, ssrc).protect(packet)

    expect(out.subarray(0, RTP_HEADER_SIZE).equals(packet.subarray(0, RTP_HEADER_SIZE))).toBe(true)
    expect(out.subarray(RTP_HEADER_SIZE, out.length - SRTP_AUTH_TAG_SIZE)
      .equals(packet.subarray(RTP_HEADER_SIZE))).toBe(false)
  })

  it('appends a ten-byte authentication tag that verifies', () => {
    const session = new SrtpSession(masterKey, masterSalt, ssrc)
    const out = session.protect(rtpPacket(100))
    const keys = deriveSessionKeys(masterKey, masterSalt)

    expect(out.length).toBe(RTP_HEADER_SIZE + 40 + SRTP_AUTH_TAG_SIZE)
    expect(verifyAuthTag(out, keys.authKey, 0)).toBe(true)
  })

  it('fails verification if a single byte is altered', () => {
    const session = new SrtpSession(masterKey, masterSalt, ssrc)
    const out = session.protect(rtpPacket(100))
    const keys = deriveSessionKeys(masterKey, masterSalt)

    out[RTP_HEADER_SIZE] = (out[RTP_HEADER_SIZE] ?? 0) ^ 0x01
    expect(verifyAuthTag(out, keys.authKey, 0)).toBe(false)
  })

  it('produces a different keystream per sequence number', () => {
    const session = new SrtpSession(masterKey, masterSalt, ssrc)
    const first = session.protect(rtpPacket(1)).subarray(RTP_HEADER_SIZE, RTP_HEADER_SIZE + 40)
    const second = session.protect(rtpPacket(2)).subarray(RTP_HEADER_SIZE, RTP_HEADER_SIZE + 40)

    expect(first.equals(second)).toBe(false)
  })

  it('produces a different keystream per SSRC', () => {
    const a = new SrtpSession(masterKey, masterSalt, 0x1111).protect(rtpPacket(1, 0x1111))
    const b = new SrtpSession(masterKey, masterSalt, 0x2222).protect(rtpPacket(1, 0x2222))

    expect(a.subarray(RTP_HEADER_SIZE, RTP_HEADER_SIZE + 40)
      .equals(b.subarray(RTP_HEADER_SIZE, RTP_HEADER_SIZE + 40))).toBe(false)
  })

  it('advances the rollover counter when the sequence number wraps', () => {
    const session = new SrtpSession(masterKey, masterSalt, ssrc)

    session.protect(rtpPacket(0xfffe))
    session.protect(rtpPacket(0xffff))
    expect(session.rolloverCounter).toBe(0)

    session.protect(rtpPacket(0x0000))
    expect(session.rolloverCounter).toBe(1)

    session.protect(rtpPacket(0x0001))
    expect(session.rolloverCounter).toBe(1)
  })

  it('does not mistake ordinary progress for a wrap', () => {
    const session = new SrtpSession(masterKey, masterSalt, ssrc)

    for (const sequence of [10, 11, 12, 500, 30_000]) {
      session.protect(rtpPacket(sequence))
    }

    expect(session.rolloverCounter).toBe(0)
  })

  it('covers the rollover counter in the tag, so index reuse is detectable', () => {
    const session = new SrtpSession(masterKey, masterSalt, ssrc)
    const keys = deriveSessionKeys(masterKey, masterSalt)

    session.protect(rtpPacket(0xffff))

    const afterWrap = session.protect(rtpPacket(0x0000))

    expect(verifyAuthTag(afterWrap, keys.authKey, 1)).toBe(true)
    expect(verifyAuthTag(afterWrap, keys.authKey, 0)).toBe(false)
  })

  it('rejects a packet shorter than an RTP header', () => {
    expect(() => new SrtpSession(masterKey, masterSalt, ssrc).protect(Buffer.alloc(8))).toThrow(/shorter than/)
  })

  it('handles an empty payload', () => {
    const out = new SrtpSession(masterKey, masterSalt, ssrc).protect(rtpPacket(1, ssrc, 0))

    expect(out.length).toBe(RTP_HEADER_SIZE + SRTP_AUTH_TAG_SIZE)
  })
})
