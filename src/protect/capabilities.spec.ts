import type { ProtectCameraConfig } from 'unifi-protect'

import { describe, expect, it } from 'vitest'

import { conformingAlternatives, describeTier, hasConformingFrameRate, joinOr, readCapabilities } from './capabilities.js'

/** The frame-rate menu a G5 Bullet actually reports, on every channel. */
const G5_FRAME_RATES = [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 18, 20, 24, 25, 30]

function channel(over: Record<string, unknown>): Record<string, unknown> {
  return {
    bitrate: 2_000_000,
    enabled: true,
    fps: 30,
    fpsValues: G5_FRAME_RATES,
    height: 720,
    id: 1,
    isRtspEnabled: true,
    maxBitrate: 2_000_000,
    minBitrate: 200_000,
    name: 'Medium',
    rtspAlias: 'alias',
    width: 1280,
    ...over,
  }
}

/** A UVC G5 Bullet as measured from a live controller on 2026-09-16. */
function g5Bullet(over: Record<string, unknown> = {}): ProtectCameraConfig {
  return {
    channels: [
      channel({ bitrate: 8_000_000, fps: 20, height: 1512, id: 0, maxBitrate: 8_000_000, name: 'High', width: 2688 }),
      channel({ id: 1, name: 'Medium' }),
      channel({ bitrate: 400_000, height: 360, id: 2, maxBitrate: 400_000, name: 'Low', width: 640 }),
    ],
    featureFlags: {
      audioCodecs: ['aac', 'opus'],
      hasMic: true,
      hasPackageCamera: false,
      hasSpeaker: false,
      isDoorbell: false,
      smartDetectTypes: ['person', 'vehicle', 'animal'],
      videoCodecs: ['h264', 'h265', 'mjpg'],
    },
    firmwareVersion: '5.4.132',
    hasSpeaker: false,
    id: 'cam-1',
    mac: 'AABBCCDDEEFF',
    marketName: 'UVC G5 Bullet',
    name: 'Office',
    type: 'UVC G5 Bullet',
    videoCodec: 'h264',
    ...over,
  } as unknown as ProtectCameraConfig
}

describe('readCapabilities', () => {
  it('reads the identity and codec surface of a G5 Bullet', () => {
    const caps = readCapabilities(g5Bullet())

    expect(caps.name).toBe('Office')
    expect(caps.model).toBe('UVC G5 Bullet')
    expect(caps.codec).toBe('h264')
    expect(caps.supportsHevc).toBe(true)
    expect(caps.smartDetectTypes).toEqual(['person', 'vehicle', 'animal'])
    expect(caps.audioCodecs).toEqual(['aac', 'opus'])
  })

  it('reads hasMic from featureFlags, where it actually lives', () => {
    // Regression: reading `hasMic` from the top level yields undefined, which is falsy,
    // so a camera with a microphone gets reported as having none.
    expect(readCapabilities(g5Bullet()).hasMic).toBe(true)
  })

  it('treats a speaker as present if either location reports one', () => {
    expect(readCapabilities(g5Bullet()).hasSpeaker).toBe(false)
    expect(readCapabilities(g5Bullet({ hasSpeaker: true })).hasSpeaker).toBe(true)

    const viaFlags = g5Bullet()

    ;(viaFlags.featureFlags as unknown as Record<string, unknown>)['hasSpeaker'] = true
    expect(readCapabilities(viaFlags).hasSpeaker).toBe(true)
  })

  it('orders tiers high to low and labels them', () => {
    const { tiers } = readCapabilities(g5Bullet())

    expect(tiers.map(t => t.quality)).toEqual(['high', 'medium', 'low'])
    expect(tiers[0]).toMatchObject({ fps: 20, height: 1512, quality: 'high', width: 2688 })
    expect(tiers[2]).toMatchObject({ height: 360, quality: 'low', width: 640 })
  })

  it('labels a two-channel camera high and low, never medium', () => {
    const caps = readCapabilities(g5Bullet({
      channels: [channel({ height: 1512, id: 0, name: 'High', width: 2688 }), channel({ height: 360, id: 1, name: 'Low', width: 640 })],
    }))

    expect(caps.tiers.map(t => t.quality)).toEqual(['high', 'low'])
  })

  it('separates a doorbell package channel from the quality tiers', () => {
    const caps = readCapabilities(g5Bullet({
      channels: [
        channel({ height: 1512, id: 0, name: 'High', width: 2688 }),
        channel({ height: 1600, id: 3, name: 'Package Camera', width: 1600 }),
      ],
    }))

    expect(caps.tiers.map(t => t.channelName)).toEqual(['High'])
    expect(caps.packageChannel?.channelName).toBe('Package Camera')
  })

  it('drops channels with nonsensical dimensions', () => {
    // A camera that is still provisioning briefly reports a 0x0 channel; advertising it
    // produces a Home app tile that never loads.
    const caps = readCapabilities(g5Bullet({
      channels: [channel({ height: 1512, id: 0, name: 'High', width: 2688 }), channel({ height: 0, id: 1, width: 0 })],
    }))

    expect(caps.tiers).toHaveLength(1)
  })

  it('falls back when a freshly adopted camera has no name', () => {
    expect(readCapabilities(g5Bullet({ name: undefined })).name).toBe('UVC G5 Bullet')
    expect(readCapabilities(g5Bullet({ marketName: undefined, name: undefined })).name).toBe('AABBCCDDEEFF')
  })

  it('sorts each tier\'s frame-rate options high to low', () => {
    expect(readCapabilities(g5Bullet()).tiers[0]?.frameRates[0]).toBe(30)
  })
})

describe('frame-rate conformance', () => {
  it('rejects the 20 fps the High channel ships with', () => {
    const high = readCapabilities(g5Bullet()).tiers[0]

    expect(high).toBeDefined()
    expect(hasConformingFrameRate(high!)).toBe(false)
  })

  it('accepts the 30 fps Medium and Low channels ship with', () => {
    const medium = readCapabilities(g5Bullet()).tiers[1]

    expect(hasConformingFrameRate(medium!)).toBe(true)
  })

  it('offers the conforming rates the channel could be set to', () => {
    const high = readCapabilities(g5Bullet()).tiers[0]

    expect(conformingAlternatives(high!)).toEqual([30, 24, 15])
  })

  it('reports no alternatives when the channel has none', () => {
    const caps = readCapabilities(g5Bullet({
      channels: [channel({ fps: 20, fpsValues: [10, 20], height: 1512, id: 0, name: 'High', width: 2688 })],
    }))

    expect(conformingAlternatives(caps.tiers[0]!)).toEqual([])
  })
})

describe('describeTier', () => {
  it('collapses to one figure when configured and ceiling agree', () => {
    const high = readCapabilities(g5Bullet()).tiers[0]

    expect(describeTier(high!)).toBe('High 2688x1512@20fps 8.0 Mbps (rtsp)')
  })

  it('shows configured and ceiling separately when they differ', () => {
    // This is the real G5 Bullet case: 8 Mbps configured against a 10 Mbps channel
    // ceiling. Quoting only one of them made the probe and the plugin disagree about the
    // same camera.
    const caps = readCapabilities(g5Bullet({
      channels: [channel({ bitrate: 8_000_000, fps: 20, height: 1512, id: 0, maxBitrate: 10_000_000, name: 'High', width: 2688 })],
    }))

    expect(describeTier(caps.tiers[0]!)).toBe('High 2688x1512@20fps 8.0/10.0 Mbps (rtsp)')
  })

  it('marks a disabled channel', () => {
    const caps = readCapabilities(g5Bullet({
      channels: [channel({ enabled: false, height: 1512, id: 0, isRtspEnabled: false, name: 'High', width: 2688 })],
    }))

    expect(describeTier(caps.tiers[0]!)).toContain('[disabled]')
  })
})

describe('joinOr', () => {
  it('reads as prose rather than a repeated conjunction', () => {
    expect(joinOr([30])).toBe('30')
    expect(joinOr([30, 24])).toBe('30 or 24')
    expect(joinOr([30, 24, 15])).toBe('30, 24 or 15')
  })

  it('handles an empty list', () => {
    expect(joinOr([])).toBe('')
  })
})
