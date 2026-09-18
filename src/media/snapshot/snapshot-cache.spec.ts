import { describe, expect, it, vi } from 'vitest'

import { SnapshotCache } from './snapshot-cache.js'

function deferred(): { promise: Promise<Buffer>, resolve: (value: Buffer) => void, reject: (error: Error) => void } {
  let resolve!: (value: Buffer) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Buffer>((res, rej) => { resolve = res; reject = rej })

  return { promise, reject, resolve }
}

const SIZE = { height: 360, width: 640 }

describe('SnapshotCache', () => {
  it('asks the controller once for concurrent requests at the same size', async () => {
    const gate = deferred()
    const load = vi.fn(() => gate.promise)
    const cache = new SnapshotCache({ load })

    const first = cache.get(SIZE, new AbortController().signal)
    const second = cache.get(SIZE, new AbortController().signal)
    const third = cache.get(SIZE, new AbortController().signal)

    gate.resolve(Buffer.from('jpeg'))

    expect(await first).toEqual(Buffer.from('jpeg'))
    expect(await second).toEqual(Buffer.from('jpeg'))
    expect(await third).toEqual(Buffer.from('jpeg'))

    // This is the case that took a live controller down: a grid of tiles asking at once.
    expect(load).toHaveBeenCalledTimes(1)
    expect(cache.stats.coalesced).toBe(2)
  })

  it('serves a fresh snapshot without asking again', async () => {
    let clock = 1000
    const load = vi.fn(() => Promise.resolve(Buffer.from('jpeg')))
    const cache = new SnapshotCache({ freshMs: 3000, load, now: () => clock })

    await cache.get(SIZE, new AbortController().signal)
    clock += 2999
    await cache.get(SIZE, new AbortController().signal)

    expect(load).toHaveBeenCalledTimes(1)
    expect(cache.stats.hits).toBe(1)
  })

  it('asks again once the snapshot is stale', async () => {
    let clock = 1000
    const load = vi.fn(() => Promise.resolve(Buffer.from('jpeg')))
    const cache = new SnapshotCache({ freshMs: 3000, load, now: () => clock })

    await cache.get(SIZE, new AbortController().signal)
    clock += 3001
    await cache.get(SIZE, new AbortController().signal)

    expect(load).toHaveBeenCalledTimes(2)
  })

  it('serves the last good snapshot when the controller times out', async () => {
    let clock = 1000
    let fail = false
    const load = vi.fn(() => fail ? Promise.reject(new Error('deadline elapsed')) : Promise.resolve(Buffer.from('good')))
    const cache = new SnapshotCache({ freshMs: 0, load, now: () => clock, staleMs: 60_000 })

    await cache.get(SIZE, new AbortController().signal)

    fail = true
    clock += 10_000

    // A ten-second-old picture beats an empty tile.
    expect(await cache.get(SIZE, new AbortController().signal)).toEqual(Buffer.from('good'))
    expect(cache.stats.staleServed).toBe(1)
    expect(cache.stats.failures).toBe(1)
  })

  it('falls back across sizes rather than failing', async () => {
    let clock = 1000
    const load = vi.fn((size: { width?: number }) =>
      (size.width === 640) ? Promise.resolve(Buffer.from('small')) : Promise.reject(new Error('deadline elapsed')))
    const cache = new SnapshotCache({ freshMs: 0, load, now: () => clock })

    await cache.get(SIZE, new AbortController().signal)
    clock += 1000

    expect(await cache.get({ height: 1080, width: 1920 }, new AbortController().signal)).toEqual(Buffer.from('small'))
  })

  it('throws when there is nothing at all to serve', async () => {
    const load = vi.fn(() => Promise.reject(new Error('deadline elapsed')))
    const cache = new SnapshotCache({ load })

    await expect(cache.get(SIZE, new AbortController().signal)).rejects.toThrow('deadline elapsed')
  })

  it('refuses to serve a snapshot older than the stale window', async () => {
    let clock = 1000
    let fail = false
    const load = vi.fn(() => fail ? Promise.reject(new Error('deadline elapsed')) : Promise.resolve(Buffer.from('good')))
    const cache = new SnapshotCache({ freshMs: 0, load, now: () => clock, staleMs: 60_000 })

    await cache.get(SIZE, new AbortController().signal)

    fail = true
    clock += 60_001

    await expect(cache.get(SIZE, new AbortController().signal)).rejects.toThrow('deadline elapsed')
  })

  it('recovers once the controller answers again', async () => {
    let clock = 1000
    let fail = true
    const load = vi.fn(() => fail ? Promise.reject(new Error('deadline elapsed')) : Promise.resolve(Buffer.from('fresh')))
    const cache = new SnapshotCache({ freshMs: 0, load, now: () => clock })

    await expect(cache.get(SIZE, new AbortController().signal)).rejects.toThrow()

    fail = false
    clock += 1000

    expect(await cache.get(SIZE, new AbortController().signal)).toEqual(Buffer.from('fresh'))
  })
})
