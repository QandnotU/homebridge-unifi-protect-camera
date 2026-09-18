import { createCipheriv, createHmac, timingSafeEqual } from 'node:crypto'

import { SRTP_AUTH_TAG_SIZE } from './h264-packetizer.js'
import { deriveKey } from './srtp.js'

/** RTCP sender report payload type (RFC 3550 §6.4.1). */
const PT_SENDER_REPORT = 200

/** Bytes in a sender report: header, SSRC, NTP, RTP timestamp, packet and octet counts. */
const SR_SIZE = 28

/** RTCP receiver report payload type (RFC 3550 §6.4.2). */
const PT_RECEIVER_REPORT = 201

/** Bytes in one report block (RFC 3550 §6.4.1). */
const REPORT_BLOCK_SIZE = 24

/** Sender info sitting between an SR header and its report blocks. */
const SENDER_INFO_SIZE = 20

/** The E flag and 31-bit index that follow an SRTCP payload. */
const SRTCP_TRAILER_SIZE = 4

/** Seconds between the NTP epoch (1900) and the Unix epoch (1970). */
const NTP_EPOCH_OFFSET = 2_208_988_800

/**
 * What a receiver is telling us about the stream we are sending it.
 *
 * This is the only direct measurement of packet loss available to a sender. Everything
 * else — the picture breaking up on movement, HomeKit renegotiating downward — is
 * inference from symptoms.
 */
export interface ReceiverReport {
  /** SSRC of the stream being reported on — ours. */
  readonly source: number
  /** Proportion of packets lost since the previous report, from 0 to 1. */
  readonly fractionLost: number
  /** Packets lost across the session. Signed, because duplicates can make it fall. */
  readonly cumulativeLost: number
  /** Interarrival jitter, in the stream's own timestamp units. */
  readonly jitter: number
  readonly highestSequence: number
}

/**
 * Extract receiver report blocks from a decrypted RTCP compound packet.
 *
 * Walks the whole compound packet, because a receiver that also sends may emit an SR and
 * an RR together: report blocks follow the sender info in the former and the header in the
 * latter. Stops at the first malformed length rather than throwing.
 */
export function parseReceiverReports(rtcp: Buffer): ReceiverReport[] {
  const reports: ReceiverReport[] = []

  let offset = 0

  while ((offset + 8) <= rtcp.length) {
    const count = rtcp.readUInt8(offset) & 0x1f
    const payloadType = rtcp.readUInt8(offset + 1)
    // Length is given in 32-bit words, minus one.
    const packetLength = (rtcp.readUInt16BE(offset + 2) + 1) * 4

    if ((packetLength < 8) || ((offset + packetLength) > rtcp.length)) {
      break
    }

    if ((payloadType === PT_RECEIVER_REPORT) || (payloadType === PT_SENDER_REPORT)) {
      let block = offset + 8 + ((payloadType === PT_SENDER_REPORT) ? SENDER_INFO_SIZE : 0)

      for (let index = 0; index < count; index++) {
        if ((block + REPORT_BLOCK_SIZE) > (offset + packetLength)) {
          break
        }

        // Fraction lost and the 24-bit signed cumulative count share one word.
        const loss = rtcp.readUInt32BE(block + 4)

        reports.push({
          cumulativeLost: ((loss & 0xffffff) << 8) >> 8,
          fractionLost: (loss >>> 24) / 256,
          highestSequence: rtcp.readUInt32BE(block + 8),
          jitter: rtcp.readUInt32BE(block + 12),
          source: rtcp.readUInt32BE(block),
        })

        block += REPORT_BLOCK_SIZE
      }
    }

    offset += packetLength
  }

  return reports
}

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

  /**
   * Decrypt an inbound SRTCP packet, or null if it is malformed or fails authentication.
   *
   * The sender's SSRC and the SRTCP index both travel in the clear — the SSRC in the
   * header, the index in the trailer — so a receiver's reports can be read with the same
   * master key without knowing its synchronisation source in advance.
   */
  unprotect(packet: Buffer): Buffer | null {
    if (packet.length < (8 + SRTCP_TRAILER_SIZE + SRTP_AUTH_TAG_SIZE)) {
      return null
    }

    const bodyEnd = packet.length - SRTP_AUTH_TAG_SIZE
    const body = packet.subarray(0, bodyEnd)
    const tag = packet.subarray(bodyEnd)
    const expected = createHmac('sha1', this.#authKey).update(body).digest().subarray(0, SRTP_AUTH_TAG_SIZE)

    if ((tag.length !== expected.length) || !timingSafeEqual(tag, expected)) {
      return null
    }

    const trailer = body.readUInt32BE(body.length - SRTCP_TRAILER_SIZE)
    const header = body.subarray(0, 8)
    const payload = body.subarray(8, body.length - SRTCP_TRAILER_SIZE)

    // The high bit of the trailer says whether the payload was encrypted at all.
    if ((trailer & 0x80000000) === 0) {
      return Buffer.concat([header, payload])
    }

    const keystream = this.#keystreamFor(body.readUInt32BE(4), trailer & 0x7fffffff, payload.length)
    const plain = Buffer.alloc(payload.length)

    for (let offset = 0; offset < payload.length; offset++) {
      plain[offset] = (payload[offset] ?? 0) ^ (keystream[offset] ?? 0)
    }

    return Buffer.concat([header, plain])
  }

  /** IV per RFC 3711 §4.1.1, with the SRTCP index in place of the packet index. */
  #keystream(length: number): Buffer {
    return this.#keystreamFor(this.#ssrc, this.#index, length)
  }

  #keystreamFor(ssrc: number, index: number, length: number): Buffer {
    const iv = Buffer.alloc(16)

    this.#salt.copy(iv, 0)
    iv.writeUInt32BE((iv.readUInt32BE(4) ^ (ssrc >>> 0)) >>> 0, 4)
    iv.writeUInt32BE((iv.readUInt32BE(10) ^ index) >>> 0, 10)

    const cipher = createCipheriv('aes-128-ctr', this.#encryptionKey, iv)

    return Buffer.concat([cipher.update(Buffer.alloc(length)), cipher.final()]).subarray(0, length)
  }
}
