/** A snapshot at a particular size, and when it was taken. */
interface Entry {
  readonly image: Buffer
  readonly at: number
}

export interface SnapshotSize {
  readonly width?: number
  readonly height?: number
}

export interface SnapshotCacheOptions {
  /** Fetches one snapshot from the controller. */
  readonly load: (size: SnapshotSize, signal: AbortSignal) => Promise<Buffer>
  /** How long a snapshot is served without asking the controller again. */
  readonly freshMs?: number
  /** How long a snapshot may still be served once fetching has failed. */
  readonly staleMs?: number
  /** Injectable clock, for tests. */
  readonly now?: () => number
}

export interface SnapshotCacheStats {
  readonly hits: number
  readonly misses: number
  readonly coalesced: number
  readonly staleServed: number
  readonly failures: number
}

/** Protect re-renders a snapshot every few seconds; asking faster returns the same picture. */
const DEFAULT_FRESH_MS = 3_000

/** A minute-old thumbnail is still recognisable. A spinner is not. */
const DEFAULT_STALE_MS = 60_000

/**
 * Snapshots, with one request to the controller at a time.
 *
 * The Home app asks every camera tile for a picture at once, and opening a camera asks
 * again at a different size. Passing each of those through to Protect unchanged is what
 * makes the controller stop answering: measured against a live NVR, five requests in 27
 * seconds produced five deadline timeouts and five empty tiles.
 *
 * Three tiers, each strictly better than failing:
 *
 * - A snapshot taken within `freshMs` is returned as-is.
 * - Concurrent requests for the same size share one in-flight fetch rather than starting
 *   their own. This is the one that matters for a grid of cameras.
 * - If fetching fails, a previous snapshot is served while it is younger than `staleMs`,
 *   preferring the requested size and falling back to any size we hold. HomeKit scales it;
 *   a slightly old picture beats an error.
 *
 * The signal passed to `load` deliberately belongs to the accessory rather than to any one
 * request: a shared fetch must not be cancelled because the caller that happened to start
 * it went away.
 */
export class SnapshotCache {
  readonly #load: (size: SnapshotSize, signal: AbortSignal) => Promise<Buffer>
  readonly #freshMs: number
  readonly #staleMs: number
  readonly #now: () => number
  readonly #entries = new Map<string, Entry>()
  readonly #inflight = new Map<string, Promise<Buffer>>()

  #hits = 0
  #misses = 0
  #coalesced = 0
  #staleServed = 0
  #failures = 0

  constructor(options: SnapshotCacheOptions) {
    this.#load = options.load
    this.#freshMs = options.freshMs ?? DEFAULT_FRESH_MS
    this.#staleMs = options.staleMs ?? DEFAULT_STALE_MS
    this.#now = options.now ?? Date.now
  }

  get stats(): SnapshotCacheStats {
    return {
      coalesced: this.#coalesced,
      failures: this.#failures,
      hits: this.#hits,
      misses: this.#misses,
      staleServed: this.#staleServed,
    }
  }

  /**
   * A snapshot at the requested size.
   *
   * Throws only when there is nothing to serve at all — no fresh picture, no successful
   * fetch, and nothing cached recently enough to stand in.
   */
  async get(size: SnapshotSize, signal: AbortSignal): Promise<Buffer> {
    const key = `${(size.width ?? 0).toString()}x${(size.height ?? 0).toString()}`
    const cached = this.#entries.get(key)

    if (cached && ((this.#now() - cached.at) < this.#freshMs)) {
      this.#hits += 1

      return cached.image
    }

    this.#misses += 1

    try {
      return await this.#fetch(key, size, signal)
    } catch (error) {
      this.#failures += 1

      const stale = this.#newestUsable(key)

      if (stale) {
        this.#staleServed += 1

        return stale
      }

      throw error
    }
  }

  /** Start a fetch, or join the one already running for this size. */
  #fetch(key: string, size: SnapshotSize, signal: AbortSignal): Promise<Buffer> {
    const existing = this.#inflight.get(key)

    if (existing) {
      this.#coalesced += 1

      return existing
    }

    const pending = this.#load(size, signal)
      .then(image => {
        this.#entries.set(key, { at: this.#now(), image })

        return image
      })
      .finally(() => { this.#inflight.delete(key) })

    this.#inflight.set(key, pending)

    return pending
  }

  /** The best still-usable snapshot: the requested size if we have one, else the newest. */
  #newestUsable(key: string): Buffer | null {
    const cutoff = this.#now() - this.#staleMs
    const preferred = this.#entries.get(key)

    if (preferred && (preferred.at >= cutoff)) {
      return preferred.image
    }

    let newest: Entry | null = null

    for (const entry of this.#entries.values()) {
      if ((entry.at >= cutoff) && (!newest || (entry.at > newest.at))) {
        newest = entry
      }
    }

    return newest?.image ?? null
  }
}
