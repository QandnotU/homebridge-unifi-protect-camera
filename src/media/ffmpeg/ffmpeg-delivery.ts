import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { Camera } from 'unifi-protect'
import type { ScopedLogger } from '../../core/logger.js'

export interface FfmpegDeliveryOptions {
  readonly camera: Camera
  readonly channelId: number
  readonly log: ScopedLogger
  readonly signal: AbortSignal
  /** Where HomeKit wants the RTP sent. */
  readonly address: string
  readonly port: number
  /** The SRTP master key and salt HomeKit negotiated, 16 and 14 bytes. */
  readonly srtpKey: Buffer
  readonly srtpSalt: Buffer
  readonly ssrc: number
  readonly payloadType: number
  readonly mtu: number
  /** Binary to run. The system ffmpeg unless overridden. */
  readonly binary?: string
}

/**
 * Deliver a Protect channel to HomeKit through FFmpeg's RTP muxer.
 *
 * An A/B reference, not the intended pipeline. The hand-rolled RTP path produces a stream
 * that measures clean by every instrument available to a sender — zero packet loss across
 * every session, 14 ms interarrival jitter, 1.4 ms send skew, byte-for-byte packetization
 * verified against a capture — and still shows artifacts on movement. That combination
 * cannot be diagnosed from inside the sender, so this exists to compare against an
 * implementation that is known to work on this hardware.
 *
 * Video is copied, never re-encoded: the comparison is of packetization and pacing alone,
 * so the bitstream HomeKit receives is byte-identical to the one our own path sends.
 * `-flags +global_header` is deliberately absent — it would move SPS and PPS out of the
 * bitstream, and HomeKit needs them in-band.
 */
export class FfmpegDelivery {
  readonly #process: ChildProcessWithoutNullStreams
  readonly #log: ScopedLogger

  #stderr = ''

  private constructor(process: ChildProcessWithoutNullStreams, log: ScopedLogger) {
    this.#process = process
    this.#log = log

    // FFmpeg reports everything on stderr. Kept for the exit message, since a failure here
    // is otherwise silent: the picture simply never arrives.
    process.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-4000)
    })

    process.on('exit', code => {
      if ((code !== 0) && (code !== null)) {
        log.warn('FFmpeg exited with %s: %s', code.toString(), this.#stderr.split('\n').slice(-4).join(' | '))
      }
    })
  }

  static arguments(options: FfmpegDeliveryOptions): string[] {
    // HomeKit hands the key and salt separately; FFmpeg wants them concatenated.
    const params = Buffer.concat([options.srtpKey, options.srtpSalt]).toString('base64')

    return [
      '-hide_banner', '-nostats',
      // Protect's fMP4 can carry a damaged fragment; continuing beats exiting mid-session.
      '-fflags', '+discardcorrupt',
      '-err_detect', 'ignore_err',
      '-max_delay', '500000',
      '-flags', 'low_delay',
      // Small, because the timeshift-free path has no backlog for FFmpeg to analyse and a
      // large probe simply delays the first picture.
      '-probesize', '65536',
      '-analyzeduration', '0',
      '-f', 'mp4', '-i', 'pipe:0',
      '-map', '0:v:0',
      '-codec:v', 'copy',
      // The livestream API delivers length-prefixed NALs; RTP needs Annex B.
      '-bsf:v', 'h264_mp4toannexb',
      '-payload_type', options.payloadType.toString(),
      '-ssrc', options.ssrc.toString(),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', params,
      `srtp://${options.address}:${options.port.toString()}?rtcpport=${options.port.toString()}&pkt_size=${(options.mtu - 28).toString()}`,
    ]
  }

  static start(options: FfmpegDeliveryOptions): FfmpegDelivery {
    const binary = options.binary ?? 'ffmpeg'
    const args = FfmpegDelivery.arguments(options)

    options.log.info('Delivering through FFmpeg: %s', binary)
    // The SRTP master key and salt travel in the arguments. They are per-session and
    // short-lived, but logging key material writes it to disk, so it is redacted — the rest
    // of the command line is what is worth being able to read back.
    options.log.debug('FFmpeg arguments: %s', args
      .map((argument, index) => ((args[index - 1] === '-srtp_out_params') ? '<redacted>' : argument))
      .join(' '))

    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    options.signal.addEventListener('abort', () => {
      child.stdin.end()
      child.kill('SIGTERM')
    }, { once: true })

    return new FfmpegDelivery(child, options.log)
  }

  /**
   * Feed one Protect channel into FFmpeg until the session ends.
   *
   * The initialisation segment is written once, ahead of the first fragment: FFmpeg's `mp4`
   * demuxer needs a header before any moof. The library yields the init as its own segment
   * as well, so that one is skipped — writing both would put two headers in the stream and
   * corrupt the demux.
   *
   * A reconnect rebases the timeline near zero, which the input flags do not tolerate
   * without `+genpts`. Rather than feed FFmpeg a backward jump, stdin is closed and the
   * session ends; HomeKit re-establishes.
   */
  async pump(options: FfmpegDeliveryOptions): Promise<void> {
    const subscription = options.camera.livestream({
      signal: options.signal,
      source: { channel: options.channelId, type: 'channel' },
    })

    if (!await subscription.whenEstablished()) {
      throw new Error(`Protect did not establish a livestream on channel ${options.channelId.toString()}`)
    }

    const init = subscription.initSegment

    if (!init) {
      throw new Error('Protect established the livestream but sent no initialisation segment')
    }

    this.#write(init.data)

    for await (const segment of subscription) {
      if (options.signal.aborted || this.#process.exitCode !== null) {
        break
      }

      if (segment.type !== 'media') {
        continue
      }

      if (segment.discontinuity) {
        this.#log.debug('Protect reconnected and rebased its timeline; ending the FFmpeg session.')
        break
      }

      this.#write(segment.data)
    }

    this.#process.stdin.end()
  }

  #write(chunk: Buffer): void {
    if (this.#process.stdin.destroyed) {
      return
    }

    // Fire and forget: a write that fails because FFmpeg has gone is not worth throwing
    // over, and the exit handler already reports why it went.
    this.#process.stdin.write(chunk, () => { /* errors surface through the exit handler */ })
  }
}
