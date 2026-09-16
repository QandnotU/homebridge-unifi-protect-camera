import type { StreamTier } from '../../protect/capabilities.js'

import { describe, expect, it } from 'vitest'

import { describeMode, formatBitrate, isTranscoding, selectStream } from './stream-selector.js'

function tier(over: Partial<StreamTier>): StreamTier {
  return {
    bitrate: 2_000_000,
    channelId: 1,
    channelName: 'Medium',
    enabled: true,
    fps: 30,
    frameRates: [30, 24, 15],
    height: 720,
    maxBitrate: 2_000_000,
    minBitrate: 200_000,
    quality: 'medium',
    rtspAlias: 'alias',
    rtspEnabled: true,
    width: 1280,
    ...over,
  }
}

/** The measured G5 Bullet tier set. */
const G5_TIERS: StreamTier[] = [
  tier({ bitrate: 8_000_000, channelId: 0, channelName: 'High', fps: 20, height: 1512, maxBitrate: 10_000_000, quality: 'high', width: 2688 }),
  tier({ channelId: 1, channelName: 'Medium', quality: 'medium' }),
  tier({ bitrate: 400_000, channelId: 2, channelName: 'Low', height: 360, maxBitrate: 1_000_000, quality: 'low', width: 640 }),
]

const h264 = { codec: 'h264', maximumQuality: false }

describe('selectStream — the passthrough cases that matter', () => {
  it('passes through 1280x720, which is what Apple Home usually asks for', () => {
    const selection = selectStream({ fps: 30, height: 720, maxBitrate: 299_000, width: 1280 }, G5_TIERS, h264)

    expect(selection?.mode).toBe('passthrough')
    expect(selection?.tier.channelName).toBe('Medium')
    expect(selection?.exactDimensions).toBe(true)
  })

  it('passes through 640x360, the other resolution Apple Home requests', () => {
    const selection = selectStream({ fps: 30, height: 360, maxBitrate: 132_000, width: 640 }, G5_TIERS, h264)

    expect(selection?.mode).toBe('passthrough')
    expect(selection?.tier.channelName).toBe('Low')
  })

  it('never transcodes an H.264 camera just because the size is inexact', () => {
    // 1920x1080 has no native match on a G5 Bullet. Sending 720p natively beats
    // re-encoding 2688x1512 down to 1080p.
    const selection = selectStream({ fps: 30, height: 1080, maxBitrate: 2_000_000, width: 1920 }, G5_TIERS, h264)

    expect(selection?.mode).toBe('passthrough-nearest')
    expect(isTranscoding(selection!.mode)).toBe(false)
    expect(selection?.tier.channelName).toBe('Medium')
  })
})

describe('selectStream — inexact matches', () => {
  it('prefers the largest stream at or below the request, so the client scales down', () => {
    const selection = selectStream({ fps: 30, height: 1080, maxBitrate: 4_000_000, width: 1920 }, G5_TIERS, h264)

    expect(selection?.tier.width).toBe(1280)
  })

  it('falls back to the smallest stream when everything is larger than the request', () => {
    const selection = selectStream({ fps: 30, height: 240, maxBitrate: 100_000, width: 320 }, G5_TIERS, h264)

    expect(selection?.tier.channelName).toBe('Low')
    expect(selection?.notes.some(n => n.includes('larger than the request'))).toBe(true)
  })

  it('explains itself in the notes', () => {
    const selection = selectStream({ fps: 30, height: 1080, maxBitrate: 4_000_000, width: 1920 }, G5_TIERS, h264)

    expect(selection?.notes.some(n => n.includes('instead of re-encoding'))).toBe(true)
  })
})

describe('selectStream — bitrate budget', () => {
  it('flags a channel configured above what HomeKit negotiated', () => {
    // The real case: Medium is capped at 2 Mbps while HomeKit asks for ~299 Kbps.
    const selection = selectStream({ fps: 30, height: 720, maxBitrate: 299_000, width: 1280 }, G5_TIERS, h264)

    expect(selection?.overBudget).toBe(true)
    expect(selection?.notes.some(n => n.includes('lower the channel bitrate'))).toBe(true)
  })

  it('stays quiet when the channel fits the budget', () => {
    const selection = selectStream({ fps: 30, height: 720, maxBitrate: 4_000_000, width: 1280 }, G5_TIERS, h264)

    expect(selection?.overBudget).toBe(false)
    expect(selection?.notes).toHaveLength(0)
  })
})

describe('selectStream — quality mode', () => {
  const duplicates = [
    tier({ bitrate: 1_000_000, channelId: 1, channelName: 'Medium Low' }),
    tier({ bitrate: 3_000_000, channelId: 2, channelName: 'Medium High' }),
  ]

  it('takes the leanest exact match by default', () => {
    const selection = selectStream({ fps: 30, height: 720, maxBitrate: 4_000_000, width: 1280 }, duplicates, h264)

    expect(selection?.tier.channelName).toBe('Medium Low')
  })

  it('takes the richest exact match under Maximum HomeKit Quality', () => {
    const selection = selectStream({ fps: 30, height: 720, maxBitrate: 4_000_000, width: 1280 },
      duplicates, { codec: 'h264', maximumQuality: true })

    expect(selection?.tier.channelName).toBe('Medium High')
  })
})

describe('selectStream — codec', () => {
  it('marks an HEVC camera for transcoding, because the classic path is H.264 only', () => {
    const selection = selectStream({ fps: 30, height: 720, maxBitrate: 2_000_000, width: 1280 },
      G5_TIERS, { codec: 'h265', maximumQuality: false })

    expect(selection?.mode).toBe('hardware-transcode')
    expect(selection?.notes[0]).toContain('H265')
    // It still picks the best source available to transcode from.
    expect(selection?.tier.channelName).toBe('High')
  })
})

describe('selectStream — unusable cameras', () => {
  it('returns null when nothing is usable rather than inventing a source', () => {
    expect(selectStream({ fps: 30, height: 720, maxBitrate: 1e6, width: 1280 }, [], h264)).toBeNull()
    expect(selectStream({ fps: 30, height: 720, maxBitrate: 1e6, width: 1280 },
      [tier({ enabled: false })], h264)).toBeNull()
  })

  it('ignores channels with no dimensions', () => {
    expect(selectStream({ fps: 30, height: 720, maxBitrate: 1e6, width: 1280 },
      [tier({ height: 0, width: 0 })], h264)).toBeNull()
  })
})

describe('formatting', () => {
  it('formats bitrates the way the diagnostic reads them', () => {
    expect(formatBitrate(8_000_000)).toBe('8.0 Mbps')
    expect(formatBitrate(299_000)).toBe('299 Kbps')
  })

  it('names each delivery mode', () => {
    expect(describeMode('passthrough')).toBe('Direct H.264 Passthrough')
    expect(describeMode('hardware-transcode')).toBe('VideoToolbox Transcode')
    expect(isTranscoding('passthrough-nearest')).toBe(false)
    expect(isTranscoding('software-transcode')).toBe(true)
  })
})
