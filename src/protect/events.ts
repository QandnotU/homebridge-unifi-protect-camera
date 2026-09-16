import type { SmartDetectType, TypedEvent } from 'unifi-protect'

/**
 * The subset of Protect's realtime stream that means something to HomeKit, normalised so
 * the rest of the plugin never has to pattern-match Protect's wire events.
 *
 * Deliberately narrow: we map only what HomeKit can represent. Protect emits plenty more
 * (ring buffer statistics, adoption progress, firmware state) and translating it would
 * add surface without adding behaviour.
 */
export type CameraEvent =
  | { readonly kind: 'motion', readonly cameraId: string, readonly eventId: string, readonly at: number }
  | {
    readonly kind: 'smartDetect'
    readonly cameraId: string
    readonly eventId: string
    readonly at: number
    readonly objectTypes: readonly SmartDetectType[]
  }
  | { readonly kind: 'doorbellRing', readonly cameraId: string, readonly eventId: string, readonly at: number }

/**
 * Translate one Protect event, or return null when it is not something HomeKit models.
 *
 * Protect already ran the detection. We never re-analyse video to derive an event it has
 * given us — see ARCHITECTURE.md's engineering principles.
 */
export function toCameraEvent(event: TypedEvent): CameraEvent | null {
  switch (event.kind) {
    case 'motionDetected':
      return { at: event.at, cameraId: event.cameraId, eventId: event.eventId, kind: 'motion' }

    case 'smartDetect':
      return {
        at: event.at,
        cameraId: event.cameraId,
        eventId: event.eventId,
        kind: 'smartDetect',
        objectTypes: event.objectTypes,
      }

    case 'doorbellRing':
      return { at: event.at, cameraId: event.cameraId, eventId: event.eventId, kind: 'doorbellRing' }

    // Inventory changes are handled by `affectsCameraInventory`; the rest carry nothing we
    // can express in HomeKit.
    case 'accessEvent':
    case 'authDetected':
    case 'bootstrapLoaded':
    case 'buttonPressed':
    case 'deviceAdded':
    case 'devicePatched':
    case 'deviceRemoved':
    case 'tamperDetected':
      return null

    default:
      return null
  }
}

/**
 * Whether an event may have changed which cameras exist or what they can do, and so
 * warrants rebuilding the capability model.
 *
 * `devicePatched` fires often (last-seen timestamps, recording state), so callers should
 * debounce and compare rather than reconciling on every one.
 */
export function affectsCameraInventory(event: TypedEvent): boolean {
  switch (event.kind) {
    case 'bootstrapLoaded':
      return true

    case 'deviceAdded':
    case 'devicePatched':
    case 'deviceRemoved':
      return event.modelKey === 'camera'

    // Enumerated rather than caught by `default`, so adding an event kind to Protect's
    // union is a lint failure that forces a decision instead of silently defaulting to
    // "does not affect inventory".
    case 'accessEvent':
    case 'authDetected':
    case 'buttonPressed':
    case 'doorbellRing':
    case 'motionDetected':
    case 'smartDetect':
    case 'tamperDetected':
      return false

    default:
      return false
  }
}

/** Smart-detect types this plugin knows how to surface in HomeKit. */
export const SUPPORTED_SMART_DETECTIONS = ['animal', 'package', 'person', 'vehicle'] as const

export type SupportedSmartDetection = typeof SUPPORTED_SMART_DETECTIONS[number]

export function isSupportedSmartDetection(value: SmartDetectType): value is SupportedSmartDetection {
  return (SUPPORTED_SMART_DETECTIONS as readonly string[]).includes(value)
}
