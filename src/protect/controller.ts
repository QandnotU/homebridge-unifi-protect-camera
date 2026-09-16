import type { Camera, ProtectClient as ProtectClientType, ProtectLogging } from 'unifi-protect'

import { FatalError, ProtectClient } from 'unifi-protect'

import type { CameraCapabilities } from './capabilities.js'
import type { CameraEvent } from './events.js'
import type { ResolvedControllerConfig } from '../types/config.js'
import type { Lifecycle } from '../core/lifecycle.js'
import type { ScopedLogger } from '../core/logger.js'
import { delay, isAbortError } from '../core/lifecycle.js'
import { affectsCameraInventory, toCameraEvent } from './events.js'
import { readCapabilities } from './capabilities.js'

/** First retry delay after a recoverable connection failure. */
const RETRY_BASE_MS = 5_000

/** Ceiling for the exponential backoff. A controller that is down stays polled, gently. */
const RETRY_MAX_MS = 5 * 60_000

/**
 * Inventory reconciliation is debounced by this much. `devicePatched` fires constantly
 * for last-seen timestamps and recording state, and rebuilding the capability model on
 * each one would be pure waste.
 */
const RECONCILE_DEBOUNCE_MS = 1_000

export interface ProtectControllerHandlers {
  /** Called with the full camera set whenever it changes, including the first time. */
  readonly onCameras: (cameras: readonly CameraCapabilities[]) => void
  readonly onEvent: (event: CameraEvent) => void
  /** Called when reachability changes, so accessories can reflect it in HomeKit. */
  readonly onReachability: (reachable: boolean) => void
}

/**
 * Owns the connection to one Protect controller.
 *
 * `ProtectClient.connect()` is atomic — it authenticates, bootstraps, opens the realtime
 * channel and returns a client that is already live — and the v5 client maintains itself
 * from there, reducing over the realtime packet stream with periodic re-bootstrap as a
 * failsafe. So this class is deliberately thin: it owns the *initial* connection with
 * backoff, distinguishes fatal from recoverable failures, and translates the library's
 * events into ours. It does not reimplement reconnection.
 */
export class ProtectController {
  readonly #config: ResolvedControllerConfig
  readonly #log: ScopedLogger
  readonly #lifecycle: Lifecycle

  #client: ProtectClientType | null = null
  #cameras: readonly CameraCapabilities[] = []
  #reconcileTimer: NodeJS.Timeout | null = null

  constructor(config: ResolvedControllerConfig, log: ScopedLogger, parent: Lifecycle) {
    this.#config = config
    this.#log = log.scope(config.name)
    this.#lifecycle = parent.child()

    this.#lifecycle.add(() => {
      if (this.#reconcileTimer) {
        clearTimeout(this.#reconcileTimer)
        this.#reconcileTimer = null
      }
    })
  }

  get displayName(): string {
    return this.#config.name
  }

  get cameras(): readonly CameraCapabilities[] {
    return this.#cameras
  }

  /**
   * The live Protect device object for a camera, which owns snapshots, livestreams and
   * talkback. Null before the controller connects.
   */
  camera(id: string): Camera | undefined {
    return this.#client?.camera(id)
  }

  /**
   * Begin connecting. Returns immediately — the connection loop runs in the background so
   * one unreachable controller never delays Homebridge startup or the other controllers.
   */
  start(handlers: ProtectControllerHandlers): void {
    void this.#run(handlers)
  }

  /** Route the library's own logging into ours, at debug so it stays out of the way. */
  #protectLog(): ProtectLogging {
    return {
      debug: (message, ...parameters) => { this.#log.debug(message, ...parameters) },
      error: (message, ...parameters) => { this.#log.debug(`protect: ${message}`, ...parameters) },
      info: (message, ...parameters) => { this.#log.debug(message, ...parameters) },
      warn: (message, ...parameters) => { this.#log.debug(`protect: ${message}`, ...parameters) },
    }
  }

  async #run(handlers: ProtectControllerHandlers): Promise<void> {
    let attempt = 0

    while (!this.#lifecycle.signal.aborted) {
      try {
        this.#log.debug('Connecting to %s ...', this.#config.host)

        const client = await ProtectClient.connect({
          host: this.#config.host,
          log: this.#protectLog(),
          password: this.#config.password,
          signal: this.#lifecycle.signal,
          username: this.#config.username,
          verifyTls: this.#config.verifyTls,
        })

        this.#client = client
        this.#lifecycle.add(async () => { await client[Symbol.asyncDispose]() })

        attempt = 0
        this.#log.success('Connected to %s (Protect %s).',
          client.controllerName ?? this.#config.host, client.nvr.config.version ?? '?')

        if (!client.isAdmin) {
          this.#log.info('This account is not an administrator. That is fine — and preferable — for read-only camera access.')
        }

        handlers.onReachability(true)
        this.#reconcile(handlers)
        this.#watchConnection(handlers)

        // Pumps until the lifecycle aborts or the controller is lost for good.
        await this.#pumpEvents(client, handlers)
      } catch (error) {
        if (isAbortError(error) || this.#lifecycle.signal.aborted) {
          return
        }

        handlers.onReachability(false)

        if (error instanceof FatalError) {
          this.#log.error('%s', describeFatal(error))
          this.#log.error('Not retrying. Correct the configuration and restart Homebridge.')

          return
        }

        attempt += 1

        const wait = Math.min(RETRY_BASE_MS * (2 ** (attempt - 1)), RETRY_MAX_MS)

        this.#log.warn('Connection failed (attempt %s): %s. Retrying in %ss.',
          attempt.toString(), describeCause(error), Math.round(wait / 1000).toString())

        try {
          await delay(wait, this.#lifecycle.signal)
        } catch {
          return
        }
      }
    }
  }

  #watchConnection(handlers: ProtectControllerHandlers): void {
    const client = this.#client

    if (!client) {
      return
    }

    const lost = client.connection.on('controllerLost', reason => {
      this.#log.warn('Controller unreachable: %s', reason.message)
      handlers.onReachability(false)
    })

    const recovered = client.connection.on('controllerRecovered', () => {
      this.#log.success('Controller reachable again.')
      handlers.onReachability(true)
      this.#reconcile(handlers)
    })

    const rebooted = client.connection.on('controllerRebooted', () => {
      this.#log.info('Controller rebooted — re-reading device inventory.')
      this.#reconcile(handlers)
    })

    this.#lifecycle.add(() => {
      lost[Symbol.dispose]()
      recovered[Symbol.dispose]()
      rebooted[Symbol.dispose]()
    })
  }

  async #pumpEvents(client: ProtectClientType, handlers: ProtectControllerHandlers): Promise<void> {
    for await (const event of client.events({ signal: this.#lifecycle.signal })) {
      if (affectsCameraInventory(event)) {
        this.#scheduleReconcile(handlers)
      }

      const cameraEvent = toCameraEvent(event)

      if (cameraEvent) {
        handlers.onEvent(cameraEvent)
      }
    }
  }

  #scheduleReconcile(handlers: ProtectControllerHandlers): void {
    if (this.#reconcileTimer) {
      return
    }

    this.#reconcileTimer = setTimeout(() => {
      this.#reconcileTimer = null
      this.#reconcile(handlers)
    }, RECONCILE_DEBOUNCE_MS)
  }

  /** Rebuild the capability model and notify only if something actually changed. */
  #reconcile(handlers: ProtectControllerHandlers): void {
    const client = this.#client

    if (!client || this.#lifecycle.signal.aborted) {
      return
    }

    const next = client.cameras
      .map(camera => camera.peek())
      .filter(config => config !== undefined)
      .map(config => readCapabilities(config))

    if (JSON.stringify(next) === JSON.stringify(this.#cameras)) {
      return
    }

    this.#cameras = next
    handlers.onCameras(next)
  }

  async dispose(): Promise<void> {
    await this.#lifecycle.dispose()
    this.#client = null
  }
}

/**
 * An error's message with any trailing full stop removed, so composing it into a larger
 * sentence does not produce a doubled period.
 */
function describeCause(error: unknown): string {
  const message = (error instanceof Error) ? error.message : String(error)

  return message.replace(/\.+$/, '')
}

/** Turn a fatal connection error into something an operator can act on. */
function describeFatal(error: FatalError): string {
  const name = error.constructor.name

  if (name === 'ProtectAuthError') {
    return `Authentication failed: ${error.message}. Check the username and password, and note that ` +
      'an account with two-factor authentication cannot be used — create a dedicated local Protect user.'
  }

  if (name === 'ProtectAuthorizationError') {
    return `Not authorised: ${error.message}. The account exists but lacks permission to view these cameras.`
  }

  return `${name}: ${error.message}`
}
