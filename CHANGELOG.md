# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Phase 0 research: `ARCHITECTURE.md` covering the Homebridge 2.x / HAP-NodeJS camera
  architecture, the real source of the 1080p ceiling, Apple's iOS 27 HomeKit Secure
  Video specification, the UniFi Protect client evaluation, and the phased plan.
- Project scaffolding: TypeScript + ESM build, strict compiler settings, ESLint, Vitest,
  Apache-2.0 license, Homebridge UI configuration schema.
- Dynamic platform skeleton with configuration validation, scoped logging, cached
  accessory tracking and `AbortController`-based shutdown.

- Phase 1 — Protect discovery. Connects to each configured controller with
  `ProtectClient.connect()`, distinguishing fatal failures (bad credentials, missing
  permission) from recoverable ones, which retry with exponential backoff to a five-minute
  ceiling. Cameras are discovered, reconciled against Homebridge's cached accessories and
  exposed with identity and a motion sensor. Realtime Protect events drive motion; smart
  detections (person, vehicle, animal) drive it too. Controller reachability is reflected
  through `StatusActive`.
- Capability model (`readCapabilities`) deriving quality tiers, codec support, audio
  capability and smart-detect types from a camera's Protect configuration. This is the
  abstraction the HomeKit renderer and stream selector both build on.
- Frame-rate conformance reporting: a channel running at a rate HomeKit will not negotiate
  is reported, along with the conforming rates it could be set to, rather than advertised
  dishonestly.
- `scripts/protect-probe.sh` for inspecting a controller's cameras, and
  `scripts/dev-homebridge.sh` for running the plugin in an isolated Homebridge instance
  with its own storage, bridge identity, PIN and port.

### Fixed

- Tier logging quoted Protect's channel *ceiling* while the probe quoted the *configured*
  bitrate, so the two tools disagreed about the same camera. Both figures are now shown.
- A smart detection whose object class Protect had not yet resolved was logged as though
  the classification were known.

- Phase 2 — live video, passthrough first. HomeKit live streaming with the camera's own
  H.264 repacketized into SRTP: no decoding, no scaling, no re-encoding, and no FFmpeg
  process in the happy path. Confirmed against a UVC G5 Bullet at 235 ms to first frame.
- Per-session diagnostics recording what HomeKit requested, which Protect channel was
  chosen, whether anything was transcoded, and the timings — including HomeKit's
  mid-session adaptive reconfigurations, which are appended rather than overwritten.
- Honest resolution advertisement: only channels the camera can actually deliver are
  offered, and each refusal is logged with its reason.

### Not yet implemented

- Snapshot coalescing and caching; snapshots currently go straight to the controller.
- HomeKit Secure Video recording — selecting "View and Record" in the Home app will fail.
- Transcoding, for streams no native channel can satisfy.
- Doorbells, two-way audio, floodlights and chimes.
