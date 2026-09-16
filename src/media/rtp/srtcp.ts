import { createCipheriv, createHmac } from 'node:crypto'

import { SRTP_AUTH_TAG_SIZE } from './h264-packetizer.js'
import { deriveKey } from './srtp.js'

/** RTCP sender report payload type (RFC 3550 §6.4.1). */
const PT_SENDER_REPORT = 200

/** Bytes in a sender report: header, SSRC, NTP, RTP timestamp, packet and octet counts. */
const SR_SIZE = 28

/** Seconds between the NTP epoch (1900) and the Unix epoch (1970). */
const NTP_EPOCH_OFFSET = 2_208_988_800

/** SRTCP key derivation labels (RFC 3711 §4.3.2). */
const Label = {
  AUTHENTICATION: 0x04,
  ENCRYPTION: 0x03,
  SALT: 0x05,
} as const

/**
 * Builds and protects RTCP sender reports for one stream.
 *
 * A receiver can decode RTP without these, which is why they were deferred — but it
 * cannot relate our RTP clock to wall time without them, so its jitter buffer is left
 * estimating. Against a live HomeKit client that showed up as intermittent stutter on an
 * otherwise smooth stream.
 *
 * SRTCP has its own key derivation, its own index and its own packet layout; it is not
 * SRTP with a different payload type.
 */
export class SrtcpSession {
  readonly #encryptionKey: Buffer
  readonly #authKey: Buffer
  readonly #salt: Buffer
  readonly #ssrc: number

  /** 31-bit SRTCP index, incremented per protected packet. */
  #index = 0

  constructor(masterKey: Buffer, masterSalt: Buffer, ssrc: number) {
    this.#encryptionKey = deriveKey(masterKey, masterSalt, Label.ENCRYPTION, 16)
    this.#authKey = deriveKey(masterKey, masterSalt, Label.AUTHENTICATION, 20)
    this.#salt = deriveKey(masterKey, masterSalt, Label.SALT, 14)
    this.#ssrc = ssrc >>> 0
  }

  get index(): number {
    return this.#index
  }

  /**
   * Build a sender report describing what we have sent so far.
   *
   * `rtpTimestamp` must correspond to `now` on the same clock the RTP stream uses; the
   * pair is precisely what lets a receiver map our media clock onto wall time.
   */
  static buildSenderReport(options: {
    ssrc: number
    rtpTimestamp: number
    packetCount: number
    octetCount: number
    now?: number
  }): Buffer {
    const report = Buffer.alloc(SR_SIZE)
    const now = options.now ?? Date.now()
    const seconds = Math.floor(now / 1000) + NTP_EPOCH_OFFSET
    const fraction = Math.floor(((now % 1000) / 1000) * 0x100000000)

    report.writeUInt8(0x80, 0)
    report.writeUInt8(PT_SENDER_REPORT, 1)
    // Length is the packet size in 32-bit words, minus one.
    report.writeUInt16BE((SR_SIZE / 4) - 1, 2)
    report.writeUInt32BE(options.ssrc >>> 0, 4)
    report.writeUInt32BE(seconds >>> 0, 8)
    report.writeUInt32BE(fraction >>> 0, 12)
    report.writeUInt32BE(options.rtpTimestamp >>> 0, 16)
    report.writeUInt32BE(options.packetCount >>> 0, 20)
    report.writeUInt32BE(options.octetCount >>> 0, 24)

    return report
  }

  /**
   * Encrypt and authenticate an RTCP packet.
   *
   * Layout: the first eight bytes stay in the clear, the remainder is encrypted, then a
   * 32-bit word carrying the encryption flag and the SRTCP index, then the tag. The tag
   * covers the index word as well, which is what stops it being replayed.
   */
  protect(packet: Buffer): Buffer {
    if (packet.length < 8) {
      throw new Error(`RTCP packet is shorter than its header: ${packet.length.toString()} bytes`)
    }

    this.#index = (this.#index + 1) & 0x7fffffff

    const header = packet.subarray(0, 8)
    const payload = packet.subarray(8)
    const keystream = this.#keystream(payload.length)
    const encrypted = Buffer.alloc(payload.length)

    for (let offset = 0; offset < payload.length; offset++) {
      encrypted[offset] = (payload[offset] ?? 0) ^ (keystream[offset] ?? 0)
    }

    const trailer = Buffer.alloc(4)

    // High bit marks the payload as encrypted.
    trailer.writeUInt32BE((this.#index | 0x80000000) >>> 0, 0)

    const body = Buffer.concat([header, encrypted, trailer])
    const tag = createHmac('sha1', this.#authKey).update(body).digest().subarray(0, SRTP_AUTH_TAG_SIZE)

    return Buffer.concat([body, tag])
  }

  /** IV per RFC 3711 §4.1.1, with the SRTCP index in place of the packet index. */
  #keystream(length: number): Buffer {
    const iv = Buffer.alloc(16)

    this.#salt.copy(iv, 0)
    iv.writeUInt32BE((iv.readUInt32BE(4) ^ this.#ssrc) >>> 0, 4)
    iv.writeUInt32BE((iv.readUInt32BE(10) ^ this.#index) >>> 0, 10)

    const cipher = createCipheriv('aes-128-ctr', this.#encryptionKey, iv)

    return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]).subarray(0, length)
  }
}
