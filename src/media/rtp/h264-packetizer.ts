import { nalType } from '../fmp4/avcc.js'

/** Bytes in a fixed RTP header with no CSRCs and no extension (RFC 3550 §5.1). */
export const RTP_HEADER_SIZE = 12

/** Authentication tag appended by `AES_CM_128_HMAC_SHA1_80`, in bytes. */
export const SRTP_AUTH_TAG_SIZE = 10

/** RFC 6184 §5.8: the packet type that carries a fragmentation unit. */
const FU_A = 28

/** Video runs on a 90 kHz RTP clock (RFC 3551 §5.1). */
export const VIDEO_CLOCK_RATE = 90_000

export interface PacketizerOptions {
  /**
   * Maximum bytes available for the RTP payload — the MTU HomeKit negotiated, less the
   * RTP header and the SRTP authentication tag. Use {@link maxPayloadSize}.
   */
  readonly maxPayloadSize: number
  /** RTP payload type HomeKit selected; 99 for H.264 in practice. */
  readonly payloadType: number
  /** Synchronisation source we told HomeKit we would send from. */
  readonly ssrc: number
  /** Initial sequence number. Randomised by default, as RFC 3550 §5.1 requires. */
  readonly initialSequence?: number
}

/** IPv4 header plus UDP header — the cost of putting a packet on the wire. */
export const IP_UDP_OVERHEAD = 28

/**
 * Bytes left for RTP payload inside a given MTU.
 *
 * The MTU HomeKit negotiates describes the **IP datagram**, not the RTP packet, so the
 * IP and UDP headers come out of the budget along with the RTP header and the SRTP
 * authentication tag. Counting only the latter two overshoots by 28 bytes.
 *
 * That overshoot is invisible on small frames and only bites on large ones: a stream
 * whose median picture is a few hundred bytes sends nothing near the limit until motion
 * or a keyframe forces fragmentation, at which point every fragment is maximum-sized.
 * The result is corruption that appears only during movement, with no packet loss
 * reported — which reads convincingly as a network problem and is not one.
 */
export function maxPayloadSize(mtu: number): number {
  return mtu - IP_UDP_OVERHEAD - RTP_HEADER_SIZE - SRTP_AUTH_TAG_SIZE
}

/**
 * Packetizes H.264 NAL units into RTP packets per RFC 6184.
 *
 * Emits single-NAL-unit packets where a NAL fits, and FU-A fragments where it does not.
 * STAP-A aggregation is deliberately not implemented: it saves a handful of packets per
 * keyframe and every HomeKit client accepts the simpler form.
 *
 * This is the passthrough path — NAL units go out exactly as the camera encoded them.
 * Nothing here decodes, scales or re-encodes.
 */
export class H264Packetizer {
  readonly #maxPayloadSize: number
  readonly #payloadType: number
  readonly #ssrc: number

  #sequence: number

  constructor(options: PacketizerOptions) {
    if (options.maxPayloadSize <= RTP_HEADER_SIZE) {
      throw new Error(`maxPayloadSize must exceed the RTP header size, got ${options.maxPayloadSize.toString()}`)
    }

    this.#maxPayloadSize = options.maxPayloadSize
    this.#payloadType = options.payloadType
    this.#ssrc = options.ssrc >>> 0
    this.#sequence = (options.initialSequence ?? Math.floor(Math.random() * 0x10000)) & 0xffff
  }

  /** The sequence number the next packet will carry. */
  get nextSequence(): number {
    return this.#sequence
  }

  /**
   * Packetize one access unit — the NAL units belonging to a single decoded picture.
   *
   * The RTP marker bit is set on the final packet, which is how the receiver knows the
   * picture is complete. Setting it per NAL instead produces a stream that decodes but
   * stutters, so access-unit grouping is the caller's responsibility.
   */
  packetizeAccessUnit(nals: readonly Buffer[], timestamp: number): Buffer[] {
    const packets: Buffer[] = []

    for (const [index, nal] of nals.entries()) {
      if (nal.length === 0) {
        continue
      }

      const isLastNal = index === (nals.length - 1)

      if (nal.length <= this.#maxPayloadSize) {
        packets.push(this.#packet(nal, timestamp, isLastNal))
        continue
      }

      packets.push(...this.#fragment(nal, timestamp, isLastNal))
    }

    return packets
  }

  /** RFC 6184 §5.8 FU-A: one NAL split across packets, headers rebuilt per fragment. */
  #fragment(nal: Buffer, timestamp: number, isLastNal: boolean): Buffer[] {
    const header = nal[0] ?? 0
    const type = nalType(nal)
    // The FU indicator keeps the original nal_ref_idc but carries type 28.
    const indicator = (header & 0xe0) | FU_A

    // Two bytes of FU indicator and FU header come out of each fragment's payload budget.
    const perFragment = this.#maxPayloadSize - 2
    const body = nal.subarray(1)
    const packets: Buffer[] = []

    for (let offset = 0; offset < body.length; offset += perFragment) {
      const chunk = body.subarray(offset, offset + perFragment)
      const isFirst = offset === 0
      const isLast = (offset + perFragment) >= body.length

      let fuHeader = type

      if (isFirst) {
        fuHeader |= 0x80
      }

      if (isLast) {
        fuHeader |= 0x40
      }

      packets.push(this.#packet(
        Buffer.concat([Buffer.from([indicator, fuHeader]), chunk]),
        timestamp,
        isLast && isLastNal,
      ))
    }

    return packets
  }

  #packet(payload: Buffer, timestamp: number, marker: boolean): Buffer {
    const header = Buffer.alloc(RTP_HEADER_SIZE)

    // Version 2, no padding, no extension, no CSRCs.
    header.writeUInt8(0x80, 0)
    header.writeUInt8((marker ? 0x80 : 0) | (this.#payloadType & 0x7f), 1)
    header.writeUInt16BE(this.#sequence, 2)
    header.writeUInt32BE(timestamp >>> 0, 4)
    header.writeUInt32BE(this.#ssrc, 8)

    this.#sequence = (this.#sequence + 1) & 0xffff

    return Buffer.concat([header, payload])
  }
}

/** Read the fields we assert on in tests and surface in diagnostics. */
export function readRtpHeader(packet: Buffer): {
  marker: boolean
  payloadType: number
  sequence: number
  ssrc: number
  timestamp: number
} {
  return {
    marker: (packet.readUInt8(1) & 0x80) !== 0,
    payloadType: packet.readUInt8(1) & 0x7f,
    sequence: packet.readUInt16BE(2),
    ssrc: packet.readUInt32BE(8),
    timestamp: packet.readUInt32BE(4),
  }
}
