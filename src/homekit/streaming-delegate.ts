import type {
  CameraStreamingDelegate, PrepareStreamCallback, PrepareStreamRequest,
  SnapshotRequest, SnapshotRequestCallback, StreamRequestCallback, StreamingRequest, VideoInfo,
} from 'homebridge'
import type { Camera } from 'unifi-protect'

import { randomInt } from 'node:crypto'

import type { CameraCapabilities } from '../protect/capabilities.js'
import type { Lifecycle } from '../core/lifecycle.js'
import type { ScopedLogger } from '../core/logger.js'
import { H264Packetizer, maxPayloadSize } from '../media/rtp/h264-packetizer.js'
import { RtpSender } from '../media/rtp/sender.js'
import { SessionMetrics } from '../diagnostics/session-metrics.js'
import { SrtpSession } from '../media/rtp/srtp.js'
import { VideoSource } from '../media/broker/video-source.js'
import { isAbortError } from '../core/lifecycle.js'
import { selectStream } from '../media/select/stream-selector.js'
import { toRtpTimestamp } from '../media/fmp4/init-segment.js'

/**
 * HAP's `StreamRequestTypes` is an *ambient const enum*, which `verbatimModuleSyntax`
 * forbids importing as a value — TS2748. Homebridge re-exports it at runtime, but the
 * type declaration makes it unusable under our compiler settings.
 *
 * So the discriminant is compared as a string and the union narrowed by hand. The values
 * are part of the HAP wire protocol and cannot drift.
 */
const START = 'start'
const RECONFIGURE = 'reconfigure'

/** The start variant of {@link StreamingRequest}, which is the one carrying full video info. */
type StartStreamRequest = Extract<StreamingRequest, { video: VideoInfo }>

function isStart(request: StreamingRequest): request is StartStreamRequest {
  return (request.type as unknown as string) === START
}

/** The reconfigure variant, which carries only dimensions and a bitrate ceiling. */
type ReconfigureStreamRequest = Exclude<StreamingRequest, StartStreamRequest>
  & { video: { height: number, max_bit_rate: number, width: number } }

function isReconfigure(request: StreamingRequest): request is ReconfigureStreamRequest {
  return (request.type as unknown as string) === RECONFIGURE
}

interface PreparedSession {
  readonly metrics: SessionMetrics
  readonly lifecycle: Lifecycle
  readonly videoSender: RtpSender
  readonly audioSender: RtpSender
  readonly srtp: SrtpSession
  readonly ssrc: number
}

export interface StreamingDelegateOptions {
  readonly camera: Camera
  readonly capabilities: () => CameraCapabilities
  readonly log: ScopedLogger
  readonly lifecycle: Lifecycle
  readonly maximumQuality: boolean
  readonly verboseDiagnostics: boolean
}

/**
 * Serves HomeKit live video from a Protect camera, passthrough first.
 *
 * The pipeline is deliberately short: Protect's fMP4 is demuxed to access units,
 * packetized per RFC 6184, protected with SRTP and sent. Nothing decodes, scales or
 * re-encodes, so the camera's own H.264 reaches HomeKit byte for byte.
 */
export class ProtectStreamingDelegate implements CameraStreamingDelegate {
  readonly #options: StreamingDelegateOptions
  readonly #log: ScopedLogger
  readonly #sessions = new Map<string, PreparedSession>()

  constructor(options: StreamingDelegateOptions) {
    this.#options = options
    this.#log = options.log
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.#options.camera.snapshot({ height: request.height, signal: this.#options.lifecycle.signal, width: request.width })
      .then(image => { callback(undefined, image) })
      .catch((error: unknown) => {
        this.#log.debug('Snapshot failed: %s', error instanceof Error ? error.message : String(error))
        callback(error instanceof Error ? error : new Error('snapshot failed'))
      })
  }

  /**
   * Allocate the sockets and keys for a session HomeKit is about to start.
   *
   * The SRTP master key and salt HomeKit supplies are used for our outbound direction and
   * echoed back, which is what every working HomeKit camera does. An audio socket is
   * bound and never written to: HomeKit expects an audio endpoint in the response even
   * when the accessory sends no audio, and omitting it fails the session.
   */
  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    const lifecycle = this.#options.lifecycle.child()
    const metrics = new SessionMetrics(request.sessionID)

    void (async (): Promise<void> => {
      try {
        const [videoSender, audioSender] = await Promise.all([
          RtpSender.bind({
            address: request.targetAddress,
            addressVersion: request.addressVersion,
            port: request.video.port,
            signal: lifecycle.signal,
          }),
          RtpSender.bind({
            address: request.targetAddress,
            addressVersion: request.addressVersion,
            port: request.audio.port,
            signal: lifecycle.signal,
          }),
        ])

        const ssrc = randomInt(1, 0xffffffff)
        const srtp = new SrtpSession(request.video.srtp_key, request.video.srtp_salt, ssrc)

        this.#sessions.set(request.sessionID, { audioSender, lifecycle, metrics, srtp, ssrc, videoSender })

        callback(undefined, {
          audio: {
            port: audioSender.localPort,
            srtp_key: request.audio.srtp_key,
            srtp_salt: request.audio.srtp_salt,
            ssrc: randomInt(1, 0xffffffff),
          },
          video: { port: videoSender.localPort, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt, ssrc },
        })
      } catch (error) {
        await lifecycle.dispose()
        this.#log.error('Could not prepare the stream: %s', error instanceof Error ? error.message : String(error))
        callback(error instanceof Error ? error : new Error('prepareStream failed'))
      }
    })()
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    if (isStart(request)) {
      this.#start(request, callback)

      return
    }

    if (isReconfigure(request)) {
      const session = this.#sessions.get(request.sessionID)

      if (session) {
        // Recorded, not acted on: HomeKit's adaptive step-downs are what we are trying to
        // observe, and re-selecting mid-session would hide them.
        session.metrics.markReconfigure(request.video.width, request.video.height, request.video.max_bit_rate * 1000)
        this.#log.debug('HomeKit reconfigured to %sx%s at %s kbps',
          request.video.width.toString(), request.video.height.toString(), request.video.max_bit_rate.toString())
      }

      callback()

      return
    }

    void this.#stop(request.sessionID)
    callback()
  }

  #start(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const session = this.#sessions.get(request.sessionID)

    if (!session) {
      callback(new Error('no prepared session for this stream request'))

      return
    }

    const video = request.video
    const capabilities = this.#options.capabilities()

    session.metrics.markRequest({
      fps: video.fps,
      height: video.height,
      level: video.level,
      local: true,
      maxBitrate: video.max_bit_rate * 1000,
      mtu: video.mtu,
      profile: video.profile,
      ssrc: session.ssrc,
      width: video.width,
    })

    const selection = selectStream(
      { fps: video.fps, height: video.height, maxBitrate: video.max_bit_rate * 1000, width: video.width },
      capabilities.tiers,
      { codec: capabilities.codec, maximumQuality: this.#options.maximumQuality },
    )

    if (!selection) {
      callback(new Error('this camera offers no usable stream'))

      return
    }

    session.metrics.markSelection(selection, capabilities.codec)

    if (selection.mode.endsWith('transcode')) {
      // Phase 6 adds conversion. Failing clearly beats a session that never produces video.
      callback(new Error(`this stream needs transcoding, which is not implemented yet (${selection.notes[0] ?? selection.mode})`))

      return
    }

    // HomeKit expects the callback promptly; the stream then runs until the session ends.
    callback()
    void this.#pump(request.sessionID, session, selection.tier.channelId, video.mtu, video.pt)
  }

  async #pump(
    sessionId: string,
    session: PreparedSession,
    channelId: number,
    mtu: number,
    payloadType: number,
  ): Promise<void> {
    try {
      const source = await VideoSource.open({
        camera: this.#options.camera,
        channelId,
        fps: this.#options.capabilities().tiers.find(tier => tier.channelId === channelId)?.fps ?? 30,
        log: this.#log,
        signal: session.lifecycle.signal,
      })

      session.metrics.markSourceOpen()

      const packetizer = new H264Packetizer({
        maxPayloadSize: maxPayloadSize(mtu),
        payloadType,
        ssrc: session.ssrc,
      })

      for await (const unit of source.accessUnits()) {
        if (session.lifecycle.signal.aborted) {
          break
        }

        session.metrics.markAccessUnit(unit.keyframe)

        const timestamp = toRtpTimestamp(unit.timestamp, source.track.timescale)

        for (const packet of packetizer.packetizeAccessUnit(unit.nals, timestamp)) {
          session.videoSender.send(session.srtp.protect(packet))
        }

        session.metrics.markFirstPacket()
      }
    } catch (error) {
      if (!isAbortError(error) && !session.lifecycle.signal.aborted) {
        this.#log.error('Streaming failed: %s', error instanceof Error ? error.message : String(error))
      }
    } finally {
      await this.#stop(sessionId)
    }
  }

  async #stop(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId)

    if (!session) {
      return
    }

    this.#sessions.delete(sessionId)

    const stats = session.videoSender.stats

    this.#log.info('%s', session.metrics.summary(stats))

    if (this.#options.verboseDiagnostics) {
      for (const line of session.metrics.report(stats)) {
        this.#log.info('  %s', line)
      }
    } else {
      for (const line of session.metrics.report(stats)) {
        this.#log.debug('  %s', line)
      }
    }

    await session.lifecycle.dispose()
  }

  /** Tear down every session — used when the accessory or the platform goes away. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map(id => this.#stop(id)))
  }
}
