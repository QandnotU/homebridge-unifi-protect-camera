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

### Not yet implemented

- Protect connectivity, camera discovery, video, snapshots and HomeKit Secure Video.
