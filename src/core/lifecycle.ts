/**
 * A disposer runs once when its {@link Lifecycle} is disposed. It must be idempotent-safe
 * and must not throw — anything that can fail should handle its own errors.
 */
export type Disposer = () => void | Promise<void>

/**
 * Groups everything a component owns — sockets, timers, event subscriptions, child
 * lifecycles — behind a single `AbortSignal` and one `dispose()` call.
 *
 * Every long-lived task in the plugin belongs to exactly one Lifecycle, so shutdown is a
 * matter of disposing the root rather than remembering what to tear down.
 */
export class Lifecycle {
  readonly #controller = new AbortController()
  readonly #disposers: Disposer[] = []
  #disposed = false

  constructor(parent?: AbortSignal) {
    // A child aborts when its parent does, but never the other way round.
    if (parent) {
      if (parent.aborted) {
        this.#controller.abort(parent.reason)
      } else {
        parent.addEventListener('abort', () => { this.#controller.abort(parent.reason) }, { once: true, signal: this.#controller.signal })
      }
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get disposed(): boolean {
    return this.#disposed
  }

  /**
   * Register a disposer. If the lifecycle is already disposed the disposer runs
   * immediately, so a late registration cannot leak.
   */
  add(disposer: Disposer): void {
    if (this.#disposed) {
      void disposer()

      return
    }

    this.#disposers.push(disposer)
  }

  /** Create a child lifecycle that this one will dispose. */
  child(): Lifecycle {
    const child = new Lifecycle(this.signal)

    this.add(() => child.dispose())

    return child
  }

  /**
   * Abort the signal, then run every disposer in reverse registration order so teardown
   * mirrors construction. Safe to call more than once.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return
    }

    this.#disposed = true
    this.#controller.abort()

    for (const disposer of this.#disposers.reverse()) {
      try {
        await disposer()
      } catch {
        // A failing disposer must not prevent the rest from running.
      }
    }

    this.#disposers.length = 0
  }
}

/**
 * Sleep that rejects on abort, so backoff loops unwind immediately at shutdown rather
 * than holding the process open for the rest of the delay.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))

      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    function onAbort(): void {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** True when a rejection is the result of an abort rather than a real failure. */
export function isAbortError(error: unknown): boolean {
  return (error instanceof Error) && (error.name === 'AbortError')
}
