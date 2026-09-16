/**
 * HAP wire values that cannot be imported.
 *
 * HAP-NodeJS declares `H264Profile`, `H264Level`, `SRTPCryptoSuites` and friends as
 * *ambient const enums*. Homebridge re-exports them at runtime, but TypeScript refuses to
 * read an ambient const enum under `verbatimModuleSyntax` (TS2748), so a strict plugin
 * cannot import them as values at all.
 *
 * These are the values from the HAP specification, restated here with that reason
 * recorded. They are part of the wire protocol and cannot drift; anything that did change
 * would break every existing camera accessory.
 */

/** `H264Profile` */
export const H264_PROFILE = {
  BASELINE: 0,
  HIGH: 2,
  MAIN: 1,
} as const

/**
 * `H264Level`. The list stops at 4.0 because HAP-NodeJS defines nothing higher — which is
 * the structural reason the classic HomeKit path cannot carry more than 1080p. See
 * ARCHITECTURE.md §Q4.
 */
export const H264_LEVEL = {
  LEVEL3_1: 0,
  LEVEL3_2: 1,
  LEVEL4_0: 2,
} as const

/** The H.264 level, as ten times the level number, that {@link H264_LEVEL.LEVEL4_0} means. */
export const MAX_ADVERTISABLE_LEVEL = 40

/** `SRTPCryptoSuites` */
export const SRTP_CRYPTO_SUITE = {
  AES_CM_128_HMAC_SHA1_80: 0,
  AES_CM_256_HMAC_SHA1_80: 1,
  NONE: 2,
} as const
