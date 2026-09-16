import { createSocket } from 'node:dgram'
import type { Socket } from 'node:dgram'

export interface RtpSenderOptions {
  /** Where HomeKit asked us to send — the `targetAddress` from `prepareStream`. */
  readonly address: string
  readonly port: number
  readonly addressVersion: 'ipv4' | 'ipv6'
  /** Aborting closes the socket. */
  readonly signal: AbortSignal
}

export interface SenderStats {
  readonly packetsSent: number
  readonly bytesSent: number
  /** Wall-clock time of the first packet, or null if nothing has been sent. */
  readonly firstPacketAt: number | null
  /** Inbound datagrams — RTCP receiver reports from HomeKit. */
  readonly inboundPackets: number
  readonly lastInboundAt: number | null
  readonly sendErrors: number
}

/**
 * A UDP socket carrying one direction of one HomeKit streaming session.
 *
 * HomeKit multiplexes RTCP onto the same port it receives RTP on, so inbound datagrams
 * arrive here too. We do not currently parse them — they are counted, because a session
 * that stops producing receiver reports has gone away and that is worth seeing in the
 * diagnostics.
 *
 * Not yet implemented: sending SRTCP sender reports. A receiver can decode our RTP
 * without them, so this is deliberately deferred until a live session shows whether
 * HomeKit needs them. SRTCP needs its own key derivation (labels 3, 4 and 5) and its own
 * index, so it is real work and should not be built speculatively.
 */
export class RtpSender {
  readonly #socket: Socket
  readonly #address: string
  readonly #port: number

  #packetsSent = 0
  #bytesSent = 0
  #firstPacketAt: number | null = null
  #inboundPackets = 0
  #lastInboundAt: number | null = null
  #sendErrors = 0
  #closed = false

  private constructor(socket: Socket, options: RtpSenderOptions) {
    this.#socket = socket
    this.#address = options.address
    this.#port = options.port

    socket.on('message', () => {
      this.#inboundPackets += 1
      this.#lastInboundAt = Date.now()
    })

    // A UDP socket can surface ICMP port-unreachable as an error event. Swallowing it
    // keeps one dead session from taking down the process; the stats record it.
    socket.on('error', () => {
      this.#sendErrors += 1
    })

    options.signal.addEventListener('abort', () => { this.close() }, { once: true })
  }

  /** Bind an ephemeral local port and prepare to send. */
  static bind(options: RtpSenderOptions): Promise<RtpSender> {
    return new Promise((resolve, reject) => {
      const socket = createSocket(options.addressVersion === 'ipv6' ? 'udp6' : 'udp4')

      const onError = (error: Error): void => {
        socket.removeAllListeners()
        socket.close()
        reject(error)
      }

      socket.once('error', onError)

      socket.bind(() => {
        socket.removeListener('error', onError)
        resolve(new RtpSender(socket, options))
      })
    })
  }

  /** The local port to report back to HomeKit in `prepareStream`. */
  get localPort(): number {
    return this.#socket.address().port
  }

  get closed(): boolean {
    return this.#closed
  }

  get stats(): SenderStats {
    return {
      bytesSent: this.#bytesSent,
      firstPacketAt: this.#firstPacketAt,
      inboundPackets: this.#inboundPackets,
      lastInboundAt: this.#lastInboundAt,
      packetsSent: this.#packetsSent,
      sendErrors: this.#sendErrors,
    }
  }

  /**
   * Send one protected packet.
   *
   * Fire and forget: UDP send failures are counted, never thrown. A streaming session
   * that raises on a dropped datagram is worse than one that keeps going.
   */
  send(packet: Buffer): void {
    if (this.#closed) {
      return
    }

    this.#socket.send(packet, this.#port, this.#address, error => {
      if (error) {
        this.#sendErrors += 1

        return
      }

      this.#packetsSent += 1
      this.#bytesSent += packet.length
      this.#firstPacketAt ??= Date.now()
    })
  }

  close(): void {
    if (this.#closed) {
      return
    }

    this.#closed = true

    try {
      this.#socket.close()
    } catch {
      // Already closed, or never fully bound.
    }
  }
}
