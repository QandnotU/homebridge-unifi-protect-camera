import type { CameraCapabilities, StreamTier } from '../../protect/capabilities.js'

import { describe, expect, it } from 'vitest'

import { advertisableResolutions, rejectionReason } from './classic-renderer.js'

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

const HIGH = tier({ channelId: 0, channelName: 'High', fps: 20, height: 1512, quality: 'high', width: 2688 })
const MEDIUM = tier({ channelId: 1, channelName: 'Medium', quality: 'medium' })
const LOW = tier({ channelId: 2, channelName: 'Low', height: 360, quality: 'low', width: 640 })

function capabilities(tiers: StreamTier[]): CameraCapabilities {
  return {
    audioCodecs: ['aac', 'opus'], codec: 'h264', firmware: '5.4.132', hasMic: true, hasPackageCamera: false,
    hasSpeaker: false, id: 'cam-1', isDoorbell: false, mac: 'AABBCCDDEEFF', model: 'UVC G5 Bullet',
    name: 'Office', packageChannel: null, smartDetectTypes: [], supportedCodecs: ['h264', 'h265'],
    supportsHevc: true, tiers, type: 'UVC G5 Bullet',
  }
}

describe('rejectionReason', () => {
  it('accepts a conforming 720p channel', () => {
    expect(rejectionReason(MEDIUM)).toBeNull()
    expect(rejectionReason(LOW)).toBeNull()
  })

  it('rejects the G5 Bullet High channel for its frame rate', () => {
    // 20 fps is not one of HomeKit's 15/24/30, and we do not advertise a rate we will not
    // send — which is the workaround other plugins use.
    expect(rejectionReason(HIGH)).toContain('20 fps')
  })

  it('rejects a resolution needing a level above the 4.0 ceiling', () => {
    // Even at a conforming frame rate, 2688x1512 is 15960 macroblocks and needs level 5.0.
    // HAP-NodeJS advertises nothing above 4.0, so this cannot be offered honestly.
    const reason = rejectionReason(tier({ fps: 30, height: 1512, width: 2688 }))

    expect(reason).toContain('5.0')
    expect(reason).toContain('4.0 ceiling')
  })

  it('accepts 1080p, which is exactly what level 4.0 admits', () => {
    expect(rejectionReason(tier({ fps: 30, height: 1080, width: 1920 }))).toBeNull()
  })

  it('rejects 4K on level grounds', () => {
    expect(rejectionReason(tier({ fps: 30, height: 2160, width: 3840 }))).toContain('5.1')
  })
})

describe('advertisableResolutions', () => {
  it('advertises only what a G5 Bullet can actually deliver', () => {
    // The High channel is excluded on both counts; what remains is real.
    expect(advertisableResolutions(capabilities([HIGH, MEDIUM, LOW]))).toEqual([[1280, 720, 30], [640, 360, 30]])
  })

  it('orders largest first', () => {
    const resolutions = advertisableResolutions(capabilities([LOW, MEDIUM]))

    expect(resolutions[0]).toEqual([1280, 720, 30])
  })

  it('skips disabled channels', () => {
    expect(advertisableResolutions(capabilities([tier({ enabled: false }), LOW]))).toEqual([[640, 360, 30]])
  })

  it('returns nothing when no channel qualifies, rather than inventing one', () => {
    expect(advertisableResolutions(capabilities([HIGH]))).toEqual([])
  })

  it('never synthesises a resolution the camera does not have', () => {
    // Other plugins pad the list with HomeKit's "mandated" 1920x1080 and 1280x720 even
    // when no channel provides them. Every entry here maps to a real Protect channel.
    const resolutions = advertisableResolutions(capabilities([MEDIUM, LOW]))
    const native = new Set([MEDIUM, LOW].map(t => `${t.width}x${t.height}`))

    for (const [width, height] of resolutions) {
      expect(native.has(`${width}x${height}`)).toBe(true)
    }
  })
})
