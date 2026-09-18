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
import { SnapshotCache } from '../media/snapshot/snapshot-cache.js'
import { SrtcpSession, parseReceiverReports } from '../media/rtp/srtcp.js'
import { SrtpSession } from '../media/rtp/srtp.js'
import { VideoSource } from '../media/broker/video-source.js'
import { isAbortError } from '../core/lifecycle.js'
import { selectStream } from '../media/select/stream-selector.js'
import { toAnnexB } from '../media/fmp4/avcc.js'
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

/**
 * Pictures are sent on the media clock, not as they arrive.
 *
 * Protect delivers roughly three pictures at once every 100 ms. Forwarding them as they
 * arrive sends a burst and then idles, which puts every frame's departure about a frame
 * period away from the time its own timestamp claims: measured at 46.5 ms mean against a
 * 33 ms frame interval, which is exactly what the arithmetic predicts for an unpaced
 * burst ((33 + 33 + 67) / 3 = 44.3).
 *
 * Three earlier schemes each fixed one measurement by breaking another, and pacing was
 * abandoned. This is the first of them — a fixed wall-clock anchor — restored, because its
 * failure had a cause that has since been removed. It drifted and then jumped to correct
 * itself; the drift was in the clock it was pacing against, which was reconstructed from
 * per-segment spacing and ran 0.92% slow (measured: 463 ms lost over 289 segments). Now
 * that segments are anchored to the controller's own `tfdt` timeline, a fixed anchor has a
 * reference that does not move under it.
 *
 * The lead exists because a segment's last picture is due 67 ms after its first but
 * arrives at the same instant: without it we would be sending late from the first frame.
 * Falling far behind re-anchors rather than sending a catch-up burst, which is what made
 * the original scheme visibly jump.
 */
/**
 * Pin a Protect channel with `PROTECT_FORCE_CHANNEL` (0 High, 1 Medium, 2 Low).
 *
 * A diagnostic, not a feature. Selection currently matches on resolution and ignores the
 * bitrate HomeKit negotiated, so a 1280x720 request is served the Medium channel at 2.0
 * Mbps against a 299 Kbps budget. Pinning the Low channel puts the source inside the budget
 * and answers whether the overrun is what breaks the picture on movement — without
 * rebuilding, and without changing selection for everyone before the answer is known.
 */
const FORCED_CHANNEL = ((): number | null => {
  const configured = Number(process.env['PROTECT_FORCE_CHANNEL'])

  return (Number.isInteger(configured) && (configured >= 0) && (configured <= 2)) ? configured : null
})()

const DEFAULT_PACING_LEAD_MS = 150

/**
 * Override with `PROTECT_PACING_LEAD_MS`, so the trade can be explored without a rebuild.
 *
 * A larger lead gives the pacer more slack to absorb a segment that arrives late, at the
 * cost of live latency. Measured on a G5 Bullet: 60 ms left a visible pause, 250 ms removed
 * it and produced the cleanest transport numbers of the project (0.9 ms mean send skew,
 * 147 ms jitter, zero loss, zero discards) — while movement artifacts returned, which those
 * numbers cannot explain. Treat the two as independent until something proves otherwise.
 */
const PACING_LEAD_MS = ((): number => {
  const configured = Number(process.env['PROTECT_PACING_LEAD_MS'])

  return (Number.isFinite(configured) && (configured >= 0) && (configured <= 2000))
    ? configured
    : DEFAULT_PACING_LEAD_MS
})()

/** Never sleep longer than this in one step, so teardown stays responsive. */
const PACING_MAX_WAIT_MS = 250

/**
 * Lag past which catching up frame by frame would take longer than the lag itself.
 *
 * Re-anchoring drops the backlog instead of replaying it at speed.
 */
const PACING_RESYNC_MS = 500

/** An abortable sleep. Resolves early, and without throwing, when the session ends. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()

      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

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
  readonly #snapshots: SnapshotCache

  constructor(options: StreamingDelegateOptions) {
    this.#options = options
    this.#log = options.log

    // The accessory's signal, not any one request's: a fetch shared between tiles must not
    // be cancelled because the tile that started it went away.
    this.#snapshots = new SnapshotCache({
      // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes an absent
      // property from one set to undefined, and the library's options mean the former.
      load: (size, signal) => options.camera.snapshot({
        signal,
        ...((size.height === undefined) ? {} : { height: size.height }),
        ...((size.width === undefined) ? {} : { width: size.width }),
      }),
    })
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.#snapshots.get({ height: request.height, width: request.width }, this.#options.lifecycle.signal)
      .then(image => { callback(undefined, image) })
      .catch((error: unknown) => {
        const stats = this.#snapshots.stats

        this.#log.debug('Snapshot failed: %s (%s served stale, %s coalesced, %s failures)',
          error instanceof Error ? error.message : String(error),
          stats.staleServed.toString(), stats.coalesced.toString(), stats.failures.toString())
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
        const ssrc = randomInt(1, 0xffffffff)
        const srtp = new SrtpSession(request.video.srtp_key, request.video.srtp_salt, ssrc)
        const srtcp = new SrtcpSession(request.video.srtp_key, request.video.srtp_salt, ssrc)

        const [videoSender, audioSender] = await Promise.all([
          RtpSender.bind({
            address: request.targetAddress,
            addressVersion: request.addressVersion,
            // HomeKit multiplexes its receiver reports onto the RTP port. Decrypting them
            // turns "the picture looks wrong" into a packet-loss figure.
            onInbound: packet => {
              const rtcp = srtcp.unprotect(packet)

              if (!rtcp) {
                return
              }

              for (const report of parseReceiverReports(rtcp)) {
                // Reports about other synchronisation sources are not about our stream.
                if (report.source === ssrc) {
                  metrics.markReceiverReport(report)
                }
              }
            },
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

        if (selection && !selection.mode.endsWith('transcode') && (FORCED_CHANNEL === null)) {
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
    void this.#pump(request.sessionID, session, FORCED_CHANNEL ?? selection.tier.channelId, video.mtu, video.pt)
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
          let paceStart: number | null = null
          // Wait for a keyframe before sending anything, on every generation including the
          // first. Protect hands us whatever point of the GOP the stream happens to be at,
          // so a session that starts mid-GOP begins with inter-coded pictures referencing
          // frames the decoder has never seen. That decodes as visible corruption until
          // the next IDR arrives.
          let ready = false

          session.lifecycle.add(() => {
            const upstream = source.stats

            this.#log.info('Pacing lead: %s ms%s.', PACING_LEAD_MS.toString(),
              (FORCED_CHANNEL === null) ? '' : `, channel pinned to ${FORCED_CHANNEL.toString()}`)

            this.#log.info('Stream health (channel %s): upstream queue peak %s, %s segment%s discarded.',
              channelId.toString(),
              String(upstream?.peakQueueDepth ?? 0),
              String(upstream?.discarded ?? 0), (upstream?.discarded === 1) ? '' : 's')

            // Our reconstructed clock against the one the controller actually stamped.
            // Measurement only: nothing downstream reads it yet.
            const timeline = source.timeline
            const timescale = source.track.timescale || 90_000

            if (timeline.samples > 0) {
              // Drift is what the old synthesised clock *would* have accumulated. Now that
              // segments are anchored to tfdt, it measures the error removed rather than
              // the error carried.
              this.#log.info('Timeline (channel %s): anchored to tfdt, avoided %s ms of drift over %s segments, %s discontinuit%s.',
                channelId.toString(),
                ((timeline.driftNow / timescale) * 1000).toFixed(0), timeline.samples.toString(),
                timeline.discontinuities.toString(), (timeline.discontinuities === 1) ? 'y' : 'ies')
            } else {
              this.#log.warn('Timeline (channel %s): no tfdt in the segments; falling back to the synthesised clock.',
                channelId.toString())
            }

            if (timeline.mismatches || timeline.trunDisagreements) {
              this.#log.info('Segment timing (channel %s): %s with a timestamp-count mismatch, %s where the splitter disagreed with the sample table.',
                channelId.toString(), timeline.mismatches.toString(), timeline.trunDisagreements.toString())
            }
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

            // Hold the picture until its own timestamp says it is due.
            const dueMs = ((unit.timestamp - base) / source.track.timescale) * 1000

            paceStart ??= Date.now() - dueMs + PACING_LEAD_MS

            const waitMs = (paceStart + dueMs) - Date.now()

            if (waitMs > 0) {
              await delay(Math.min(waitMs, PACING_MAX_WAIT_MS), session.lifecycle.signal)

              if (session.lifecycle.signal.aborted) {
                return
              }
            } else if (waitMs < -PACING_RESYNC_MS) {
              paceStart = Date.now() - dueMs
            }

            const relative = toRtpTimestamp(unit.timestamp - base, source.track.timescale)

            lastTimestamp = timestampOffset + relative
            session.metrics.markAccessUnit(unit.keyframe)
            session.metrics.markSend(lastTimestamp)

            // Pace relative to the previous picture, not to a fixed anchor at session
            // start. An absolute anchor accumulates the difference between our media clock
            // and real time — about 0.8% per second measured here — until it is far enough
            // behind to need a correction, and that correction is a discontinuity the
            // receiver sees as ~800ms of interarrival jitter. Spacing each picture from the
            // last one self-corrects: falling behind simply means sending now and carrying
            // on evenly, with nothing to accumulate.
            dump?.write(toAnnexB(unit.nals))

            const packets = packetizer.packetizeAccessUnit(unit.nals, lastTimestamp)

            for (const packet of packets) {
              rtpPackets += 1
              rtpOctets += packet.length - RTP_HEADER_SIZE
              session.videoSender.send(session.srtp.protect(packet))
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
