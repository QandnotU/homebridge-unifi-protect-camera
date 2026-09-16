# homebridge-unifi-protect-camera

A modern Homebridge plugin bringing UniFi Protect cameras to Apple Home and HomeKit
Secure Video — built passthrough-first, local-first, for Homebridge 2.x.

> **Status: early development.** Phase 0 (research) is complete and documented in
> [ARCHITECTURE.md](./ARCHITECTURE.md). The plugin loads and validates configuration but
> does not yet connect to Protect or expose any cameras. It is not usable yet, and there
> is no published release.

## Why another UniFi Protect plugin

[`homebridge-unifi-protect`](https://github.com/hjdhjd/homebridge-unifi-protect) is
excellent and covers the whole Protect estate. This plugin is deliberately narrower and
optimises for one thing: **the best possible video path to Apple Home.**

- **Passthrough first.** Send the camera's native H.264 to HomeKit without decoding and
  re-encoding it. FFmpeg is a fallback, not the pipeline.
- **No hardcoded 1080p ceiling.** Capabilities are built from what the camera offers,
  what HAP-NodeJS permits, and what the Home app actually asks for — not from
  assumptions about past HomeKit limits.
- **Diagnostics as a feature.** Every streaming session reports what HomeKit requested,
  which Protect stream was chosen, whether anything was transcoded, and how long it took
  to first frame. It should be obvious at a glance whether you are getting native video.
- **Local only.** No Ubiquiti cloud dependency, ever.

## Requirements

| | |
|---|---|
| Node.js | 22.20+, 24 or 26 |
| Homebridge | 2.0 or later |
| UniFi Protect | a controller reachable on your local network |
| Protect account | a **dedicated local user** — not a Ubiquiti cloud account |

## Configuration

Configure through the Homebridge UI, or in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "UniFiProtectCamera",
      "name": "UniFi Protect Camera",
      "controllers": [
        {
          "name": "Home NVR",
          "host": "192.168.1.1",
          "username": "homebridge",
          "password": "your-password",
          "verifyTls": false
        }
      ],
      "options": {
        "maximumQuality": false,
        "verboseDiagnostics": false
      }
    }
  ]
}
```

### Controllers

| Field | Required | Default | Notes |
|---|---|---|---|
| `host` | yes | — | Hostname or IP on your local network |
| `username` | yes | — | Dedicated local Protect user |
| `password` | yes | — | |
| `name` | no | the host | Label used in logs |
| `verifyTls` | no | `false` | Protect uses a self-signed certificate by default |

A malformed controller entry is skipped with a warning rather than taking down the
others. Credentials are never written to the log.

### Options

| Field | Default | Notes |
|---|---|---|
| `maximumQuality` | `false` | Always prefer the highest-quality compatible Protect stream; never step down to save bandwidth. Never overrides what HomeKit negotiated. |
| `verboseDiagnostics` | `false` | Log the full per-session record instead of a one-line summary |

## Development

```bash
nvm use            # honours .nvmrc (Node 24)
npm install
npm run check      # lint + typecheck + tests
npm run build      # emit to dist/
npm run watch      # rebuild on change
```

To run it against a local Homebridge instance:

```bash
npm link
homebridge -D -U ~/.homebridge-dev
```

## Design

[ARCHITECTURE.md](./ARCHITECTURE.md) is the reference document: the current Homebridge
2.x / HAP-NodeJS camera architecture, where the real resolution limits live, Apple's
iOS 27 HomeKit Secure Video changes, the video pipeline design, and the phased plan.
Read it before changing anything in the media path.

## License

[Apache-2.0](./LICENSE)
