import type {
  CameraStreamingDelegate, PrepareStreamCallback, PrepareStreamRequest,
  SnapshotRequest, SnapshotRequestCallback, StreamRequestCallback, StreamingRequest, VideoInfo,
} from 'homebridge'
import type { Camera } from 'unifi-protect'

import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { randomInt } from 'node:crypto'
import type { WriteStream } from 'node:fs'

import type { CameraCapabilities } from '../protect/capabilities.js'
import type { Lifecycle } from '../core/lifecycle.js'
import type { ScopedLogger } from '../core/logger.js'
import { H264Packetizer, RTP_HEADER_SIZE, maxPayloadSize } from '../media/rtp/h264-packetizer.js'
import { RtpSender } from '../media/rtp/sender.js'
import { SessionMetrics } from '../diagnostics/session-metrics.js'
import { SrtcpSession } from '../media/rtp/srtcp.js'
import { SrtpSession } from '../media/rtp/srtp.js'
import { VideoSource } from '../media/broker/video-source.js'
import { delay, isAbortError } from '../core/lifecycle.js'
import { selectStream } from '../media/select/stream-selector.js'
import { toAnnexB } from '../media/fmp4/avcc.js'
import { RTP_VIDEO_CLOCK, toRtpTimestamp } from '../media/fmp4/init-segment.js'

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

/**
 * How far ahead of the media clock the sender may run before it waits.
 *
 * Protect delivers roughly three pictures per 100 ms segment, and releasing them all at
 * once produces a burst well above the stream's average rate. On a moving scene those
 * pictures are large, and the burst overruns the receiver's buffer — which shows up as
 * corruption concentrated in the moving parts of the frame, and provokes HomeKit into
 * renegotiating down to a lower resolution.
 *
 * Pacing to the media clock spreads them evenly instead. This is what a conventional RTP
 * sender does; we only notice its absence because the source arrives in bursts.
 */
const PACING_LEAD_MS = 8

/** Never wait longer than this, so a timestamp jump cannot stall the stream. */
const PACING_MAX_WAIT_MS = 250

/**
 * How far behind schedule the sender may fall before it stops trying to catch up.
 *
 * Catching up means transmitting the backlog as fast as the loop runs, which is the burst
 * that pacing exists to avoid — the stream freezes and then races, shedding packets as it
 * goes. Past this point the schedule is re-anchored instead: the latency already incurred
 * is accepted, and delivery stays even from there.
 */
const PACING_RESYNC_MS = 400

/**
 * Set `PROTECT_DUMP_DIR` to write each session's video to an Annex-B `.h264` file.
 *
 * This is the only way to tell a demuxing fault from a transport fault. Whatever lands in
 * the file is exactly what we hand the packetizer: if it plays back cleanly, the pictures
 * we produce are correct and any corruption is happening on the wire; if the file itself
 * is broken, the fault is upstream of RTP entirely.
 *
 *   PROTECT_DUMP_DIR=/tmp/protect bash scripts/dev-homebridge.sh
 *   ffplay /tmp/protect/<session>.h264
 */
const DUMP_DIR = process.env['PROTECT_DUMP_DIR'] ?? ''

/**
 * How many pauses a single frame's packets may be broken up with.
 *
 * A keyframe captured during movement was measured at 107 KB — 79 packets — and releasing
 * those with no gap puts roughly 109 KB on the wire at once, far above the stream's
 * 569 Kbps average. Enough of that burst is lost that the keyframe is damaged, and every
 * picture referencing it stays corrupt until the next one.
 *
 * The count is bounded rather than the group size, because the cost of a pause is not the
 * millisecond requested. Node's timers resolve to whole milliseconds and overshoot under
 * load, so a pause costs 1–4 ms in practice. Spacing every eight packets meant nine pauses
 * for that keyframe — up to 36 ms, past its 33 ms budget at 30 fps. The sender then fell
 * further behind the media clock on every large frame until a resync caught it up in one
 * burst: better at first, then degrading. Four pauses cost at most ~16 ms and still break
 * the frame into fifths.
 */
const MAX_FRAME_PAUSES = 4

/** Below this, a frame is small enough to send in one go. Median frame is ~1.6 KB. */
const PAUSE_ABOVE_PACKETS = 8

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
  readonly srtcp: SrtcpSession
  readonly ssrc: number
  /**
   * Channel the pump should switch to, set when HomeKit reconfigures the session.
   * Mutable by design: the pump is a long-running loop and this is how it is steered.
   */
  readonly control: { pendingChannelId: number | null }
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
        const srtcp = new SrtcpSession(request.video.srtp_key, request.video.srtp_salt, ssrc)

        this.#sessions.set(request.sessionID,
          { audioSender, control: { pendingChannelId: null }, lifecycle, metrics, srtcp, srtp, ssrc, videoSender })

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
        const { height, max_bit_rate: maxBitrate, width } = request.video

        session.metrics.markReconfigure(width, height, maxBitrate * 1000)

        // Act on it. HomeKit steps a session down within seconds of opening it, and a
        // client that has renegotiated to 640x360 stops accepting the 1280x720 it was
        // receiving — the picture simply freezes. Recording the change without honouring
        // it was the cause.
        const capabilities = this.#options.capabilities()
        // A reconfigure carries no frame rate — only dimensions and a bitrate ceiling — so
        // the selector is asked for the highest rate HomeKit negotiates and picks the
        // channel on size, which is what actually decides the source.
        const selection = selectStream(
          { fps: 30, height, maxBitrate: maxBitrate * 1000, width },
          capabilities.tiers,
          { codec: capabilities.codec, maximumQuality: this.#options.maximumQuality },
        )

        if (selection && !selection.mode.endsWith('transcode')) {
          session.control.pendingChannelId = selection.tier.channelId
        }

        this.#log.info('HomeKit reconfigured to %sx%s at %s Kbps -> %s channel',
          width.toString(), height.toString(), maxBitrate.toString(),
          selection?.tier.channelName ?? 'unchanged')
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

  /**
   * Stream until the session ends, switching source when HomeKit reconfigures.
   *
   * The packetizer and SRTP session persist across a switch so RTP sequence numbers stay
   * continuous, and timestamps are offset so they never move backwards — a receiver
   * treats a backwards jump as a new stream and stalls.
   */
  async #pump(
    sessionId: string,
    session: PreparedSession,
    initialChannelId: number,
    mtu: number,
    payloadType: number,
  ): Promise<void> {
    const packetizer = new H264Packetizer({ maxPayloadSize: maxPayloadSize(mtu), payloadType, ssrc: session.ssrc })

    let lastTimestamp = 0
    let dump: WriteStream | null = null

    if (DUMP_DIR) {
      dump = createWriteStream(join(DUMP_DIR, `${sessionId}.h264`))
      session.lifecycle.add(() => { dump?.end() })
      this.#log.info('Writing this session\'s video to %s', join(DUMP_DIR, `${sessionId}.h264`))
    }

    // Counted here rather than read from the socket: the socket also carries the sender
    // reports themselves, and RFC 3550's octet count excludes RTP headers. Taking the
    // socket's totals would make every report overstate the stream it describes.
    let rtpPackets = 0
    let rtpOctets = 0

    // RFC 3550 puts the minimum reporting interval at five seconds for a session this
    // small. The receiver needs at least one report early to relate our media clock to
    // wall time, so the first goes out a second in.
    const report = (): void => { this.#sendReport(session, lastTimestamp, rtpPackets, rtpOctets) }
    const reporter = setInterval(report, 5_000)
    const firstReport = setTimeout(report, 1_000)

    session.lifecycle.add(() => {
      clearInterval(reporter)
      clearTimeout(firstReport)
    })

    let channelId = initialChannelId
    let timestampOffset = 0
    let pacingBase: number | null = null
    let pacingStart: number | null = null
    let resyncs = 0
    let first = true

    try {
      while (!session.lifecycle.signal.aborted) {
        session.control.pendingChannelId = null

        const generation = session.lifecycle.child()

        try {
          const tier = this.#options.capabilities().tiers.find(entry => entry.channelId === channelId)
          const source = await VideoSource.open({
            camera: this.#options.camera,
            channelId,
            fps: tier?.fps ?? 30,
            log: this.#log,
            signal: generation.signal,
          })

          if (first) {
            session.metrics.markSourceOpen()
          }

          // After a switch, resume the RTP clock where it left off.
          let base: number | null = null
          // Wait for a keyframe before sending anything, on every generation including the
          // first. Protect hands us whatever point of the GOP the stream happens to be at,
          // so a session that starts mid-GOP begins with inter-coded pictures referencing
          // frames the decoder has never seen. That decodes as visible corruption until
          // the next IDR arrives.
          let ready = false

          session.lifecycle.add(() => {
            const upstream = source.stats

            this.#log.info('Stream health: %s pacing resync%s, upstream queue peak %s, %s segment%s discarded.',
              resyncs.toString(), resyncs === 1 ? '' : 's',
              String(upstream?.peakQueueDepth ?? 0),
              String(upstream?.discarded ?? 0), (upstream?.discarded === 1) ? '' : 's')
          })

          for await (const unit of source.accessUnits()) {
            if (session.lifecycle.signal.aborted) {
              return
            }

            if ((session.control.pendingChannelId !== null) && (session.control.pendingChannelId !== channelId)) {
              break
            }

            if (!ready) {
              if (!unit.keyframe) {
                continue
              }

              ready = true
            }

            base ??= unit.timestamp

            const relative = toRtpTimestamp(unit.timestamp - base, source.track.timescale)

            lastTimestamp = timestampOffset + relative
            session.metrics.markAccessUnit(unit.keyframe)

            // Pace to the media clock rather than to the arrival of segments.
            pacingBase ??= lastTimestamp
            pacingStart ??= performance.now()

            const dueAt = pacingStart + (((lastTimestamp - pacingBase) / RTP_VIDEO_CLOCK) * 1000)
            const wait = dueAt - performance.now()

            if (wait > PACING_LEAD_MS) {
              try {
                await delay(Math.min(wait, PACING_MAX_WAIT_MS), session.lifecycle.signal)
              } catch {
                return
              }
            } else if (wait < -PACING_RESYNC_MS) {
              resyncs += 1
              pacingBase = lastTimestamp
              pacingStart = performance.now()
            }

            dump?.write(toAnnexB(unit.nals))

            const packets = packetizer.packetizeAccessUnit(unit.nals, lastTimestamp)

            // Break a large frame into at most MAX_FRAME_PAUSES + 1 groups; small frames
            // go out in one piece.
            const groupSize = (packets.length > PAUSE_ABOVE_PACKETS)
              ? Math.ceil(packets.length / (MAX_FRAME_PAUSES + 1))
              : packets.length

            for (const [index, packet] of packets.entries()) {
              rtpPackets += 1
              rtpOctets += packet.length - RTP_HEADER_SIZE
              session.videoSender.send(session.srtp.protect(packet))

              if (((index + 1) % groupSize === 0) && ((index + 1) < packets.length)) {
                try {
                  await delay(1, session.lifecycle.signal)
                } catch {
                  return
                }
              }
            }

            session.metrics.markFirstPacket()
            first = false
          }
        } finally {
          await generation.dispose()
        }

        const next = session.control.pendingChannelId

        if ((next === null) || (next === channelId) || session.lifecycle.signal.aborted) {
          return
        }

        // Leave a frame's gap so the new stream's first timestamp is strictly greater.
        timestampOffset = lastTimestamp + 3000
        pacingBase = null
        pacingStart = null
        channelId = next
        this.#log.debug('Switching to channel %s.', channelId.toString())
      }
    } catch (error) {
      if (!isAbortError(error) && !session.lifecycle.signal.aborted) {
        this.#log.error('Streaming failed: %s', error instanceof Error ? error.message : String(error))
      }
    } finally {
      await this.#stop(sessionId)
    }
  }

  /**
   * Send a sender report describing the stream so far, giving the receiver the
   * RTP-to-wall-clock mapping its jitter buffer needs.
   */
  #sendReport(session: PreparedSession, rtpTimestamp: number, packetCount: number, octetCount: number): void {
    if (session.lifecycle.signal.aborted || session.videoSender.closed || (packetCount === 0)) {
      return
    }

    try {
      const report = SrtcpSession.buildSenderReport({ octetCount, packetCount, rtpTimestamp, ssrc: session.ssrc })

      session.videoSender.send(session.srtcp.protect(report))
    } catch (error) {
      this.#log.debug('Sender report failed: %s', error instanceof Error ? error.message : String(error))
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
