import type { TypedEvent } from 'unifi-protect'

import { describe, expect, it } from 'vitest'

import { affectsCameraInventory, isSupportedSmartDetection, toCameraEvent } from './events.js'

const at = 1_760_000_000_000

describe('toCameraEvent', () => {
  it('translates motion', () => {
    const event: TypedEvent = { at, cameraId: 'cam-1', eventId: 'evt-1', kind: 'motionDetected' }

    expect(toCameraEvent(event)).toEqual({ at, cameraId: 'cam-1', eventId: 'evt-1', kind: 'motion' })
  })

  it('translates smart detections and preserves every object type', () => {
    const event: TypedEvent = {
      at,
      cameraId: 'cam-1',
      eventId: 'evt-2',
      kind: 'smartDetect',
      objectTypes: ['person', 'vehicle'],
    }

    expect(toCameraEvent(event)).toEqual({
      at,
      cameraId: 'cam-1',
      eventId: 'evt-2',
      kind: 'smartDetect',
      objectTypes: ['person', 'vehicle'],
    })
  })

  it('translates a doorbell ring', () => {
    const event: TypedEvent = { at, cameraId: 'cam-1', eventId: 'evt-3', kind: 'doorbellRing' }

    expect(toCameraEvent(event)?.kind).toBe('doorbellRing')
  })

  it('ignores events HomeKit cannot represent', () => {
    const ignored: TypedEvent[] = [
      { at, cameraId: 'cam-1', eventId: 'e', kind: 'tamperDetected' },
      { at, cameraId: 'cam-1', eventId: 'e', kind: 'authDetected', method: 'nfc' },
      { action: 'open', at, deviceId: 'd', eventId: 'e', kind: 'accessEvent' },
      { at, button: '1', deviceId: 'd', eventId: 'e', kind: 'buttonPressed', pressType: 'single' },
      { id: 'cam-1', kind: 'deviceRemoved', modelKey: 'camera' },
    ]

    for (const event of ignored) {
      expect(toCameraEvent(event)).toBeNull()
    }
  })
})

describe('affectsCameraInventory', () => {
  it('treats a fresh bootstrap as a full inventory change', () => {
    expect(affectsCameraInventory({ data: {} as never, kind: 'bootstrapLoaded' })).toBe(true)
  })

  it('reacts to camera add, patch and remove', () => {
    expect(affectsCameraInventory({ data: {} as never, id: 'c', kind: 'deviceAdded', modelKey: 'camera' })).toBe(true)
    expect(affectsCameraInventory({ id: 'c', kind: 'devicePatched', modelKey: 'camera', patch: {} })).toBe(true)
    expect(affectsCameraInventory({ id: 'c', kind: 'deviceRemoved', modelKey: 'camera' })).toBe(true)
  })

  it('ignores device changes for other model kinds', () => {
    expect(affectsCameraInventory({ id: 'l', kind: 'devicePatched', modelKey: 'light', patch: {} })).toBe(false)
    expect(affectsCameraInventory({ id: 's', kind: 'deviceRemoved', modelKey: 'sensor' })).toBe(false)
  })

  it('ignores activity events', () => {
    expect(affectsCameraInventory({ at, cameraId: 'c', eventId: 'e', kind: 'motionDetected' })).toBe(false)
    expect(affectsCameraInventory({ at, cameraId: 'c', eventId: 'e', kind: 'doorbellRing' })).toBe(false)
  })
})

describe('isSupportedSmartDetection', () => {
  it('accepts what the G5 Bullet reports', () => {
    expect(['person', 'vehicle', 'animal'].every(isSupportedSmartDetection)).toBe(true)
  })

  it('rejects detections we do not map', () => {
    expect(isSupportedSmartDetection('face')).toBe(false)
    expect(isSupportedSmartDetection('licensePlate')).toBe(false)
  })
})
