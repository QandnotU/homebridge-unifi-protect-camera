# ARCHITECTURE.md

**UniFi Protect → Apple Home / HomeKit Secure Video, Homebridge 2.x**
Phase 0 research findings. Written 2026-09-15.

> **Status: research complete, no implementation code written.** Everything below is
> sourced from the actual published packages and Apple's own specification, with file
> and line references. Where something is unverified, it says so explicitly.

---

## 0. Executive summary

There are now **two** HomeKit camera architectures, not one.

| | Classic HAP camera | HKSV3 / "secure video" (iOS 27) |
|---|---|---|
| HAP-NodeJS support | ✅ mature (`CameraController`) | ❌ **none in 2.2.3** |
| Video codec | **H.264 only** | HEVC mandatory; H.264 local-only |
| Resolution ceiling | **1080p in practice** | 4K / 2K / 1080p by tier |
| Negotiation | Apple picks W×H×fps×bitrate | Apple picks **a tier you defined** |
| Recording | fMP4 fragments over HDS | fMP4 over HDS, or CMAF upload |
| Remote viewing | relayed RTP | WebRTC + SFrame |

**The single most important finding:** the reason the classic path stops at 1080p is
not a Homebridge limitation and not an arbitrary Apple policy. It is the H.264 **level**
enum. `H264Level` tops out at `LEVEL4_0`, and H.264 Level 4.0 has `MaxFS = 8192`
macroblocks. 1920×1080 is 8160 macroblocks. It fits with 32 macroblocks to spare, and
nothing larger fits at all. That is the whole story of the 1080p ceiling.

**The second most important finding:** Apple published a new specification on
2026-06-03 — the *HomeKit Secure Video Open Source Compatibility Guide* (Developer
Preview, v1.0) — that replaces the resolution/bitrate negotiation with a **tier**
model that has **no level field whatsoever**. In the new model you advertise concrete
`(codec, width, height, fps, bitrate)` tuples and the controller selects one by
identifier. That is *exactly* the passthrough-first model this project wants.

**The catch:** the new spec says "The accessory must support High Efficiency Video
Coding (HEVC)" and "The accessory must support Opus audio encoding." The G5 Bullets
are currently running H.264. Whether they *can* run H.265 is the one fact that most
changes this project's shape, and it is checkable in about thirty seconds against your
own controller (see §8.1).

**Answers in one line each:**

1. **Modern architecture?** TypeScript + ESM dynamic platform, `CameraController` from `homebridge`, `CameraStreamingDelegate` + `CameraRecordingDelegate`.
2. **Live-stream resolutions?** Anything up to 65535×65535 — the type is a free tuple and there is no validation. But Apple only *requests* ≤1080p on this path.
3. **HKSV resolutions?** Same — unconstrained advertisement, same practical ceiling.
4. **Explicit 1080p limits?** No literal limit. An *implicit* one via `H264Level.LEVEL4_0`.
5. **OS 27 implemented?** **No.** Zero of ~35 new service/characteristic UUIDs exist in HAP-NodeJS 2.2.3. Draft PR #1132 (opened 2026-09-15) implements it.
6. **H.264 profiles/levels?** Baseline/Main/High; levels 3.1/3.2/4.0 only.
7. **Direct H.264 without FFmpeg?** **Yes.** HAP-NodeJS never touches media — it hands you SRTP keys and a destination.
8. **Work to expose 2688×1512?** Route A (classic): upstream level enum change, speculative. Route B (HKSV3): adopt PR #1132's tier model, which has no level field.
9. **What prevents it today?** HAP-NodeJS has no OS 27 code; classic path is level-capped; Apple's new path effectively wants HEVC.
10. **What to use from `unifi-protect` v5?** Everything except media handling — auth, bootstrap, realtime, state, livestream pool, talkback.

---

## 1. Version baseline

### 1.1 Published, as of 2026-09-15

| Package | Latest | Notes |
|---|---|---|
| `homebridge` | **2.4.0** | `engines.node: ^22 \|\| ^24 \|\| ^26`, `"type": "module"` |
| `@homebridge/hap-nodejs` | **2.2.3** | Homebridge 2.4.0 pins **2.2.2** |
| `hap-nodejs` (old scope) | 0.14.3 | dead for our purposes |
| `unifi-protect` | **5.3.1** | hjdhjd, ESM, `engines.node: >=22.20`, one dep (`undici`) |
| `homebridge-unifi-protect` | **8.1.0** | hjdhjd, ESM, depends on `unifi-protect` **5.2.0** |
| `homebridge-plugin-template` | branch `latest` | pushed 2026-08-23, `is_template: true` |

Template's `engines`: `node: ^22.10.0 || ^24.0.0`, `homebridge: ^1.8.0 || ^2.0.0`.
Template ships TypeScript 6, ESLint 10, `build: rimraf ./dist && tsc`, `main: dist/index.js`.
It depends on `homebridge-lib@^8.1.4` — **drop that**; it is not needed for a camera
plugin and pulls in surface we do not want.

### 1.2 This machine

```
node      v20.20.0      ← TOO OLD. Homebridge 2.x needs ^22 || ^24 || ^26.
npm       10.8.2
ffmpeg    7.1.1 (homebrew) with --enable-videotoolbox --enable-audiotoolbox
          encoders: h264_videotoolbox, hevc_videotoolbox, prores_videotoolbox
          hwaccels: videotoolbox
CPU       Apple M4
OS        macOS 27.0 (build 26A428)
```

Two notes:

- **Node 20 will not run Homebridge 2.x.** First setup step is `nvm install 22` (or 24).
- The brief says the dev box is an **M1** Mac mini; this machine reports an **M4**.
  Not a problem — M4's VideoToolbox is a superset — but the two encoders differ in
  throughput, so don't benchmark here and quote the numbers as M1 numbers.

No Homebridge install was found on this machine. The only local copies of
`homebridge` / `@homebridge/hap-nodejs` are vendored inside two unrelated projects
(`~/Developer/homebridge-molekule` at homebridge 2.1.0 / hap 2.1.7, and
`~/Developer/homebridge-pura` at 2.0.0-beta.71 / hap 2.1.0). Research below was done
against freshly cloned `homebridge/HAP-NodeJS` at tag **v2.2.3**
(`25e8bea26a64309a47184dec478479483fbdd50c`), which is byte-identical to the published
package.

---

## 2. The two architectures

### 2.1 Classic HAP camera (what HAP-NodeJS implements today)

Services: `CameraRTPStreamManagement`, `CameraOperatingMode`, `CameraEventRecordingManagement`.

Flow:

```
accessory advertises SupportedVideoStreamConfiguration (codec, profiles, levels, [W,H,fps]...)
        ↓
iOS writes SelectedRTPStreamConfiguration  →  plugin gets StartStreamRequest
        ↓
plugin sends SRTP itself to the address/keys from PrepareStreamRequest
```

Everything the accessory advertises and everything iOS selects is a
**resolution/profile/level/bitrate tuple negotiated per session**.

### 2.2 HKSV3 / iOS 27 (Apple's 2026-06-03 spec)

Apple's *HomeKit Secure Video Open Source Compatibility Guide*, v1.0, 2026-06-03,
Developer Preview. It "complements version R17 or later of the official HomeKit
Accessory Protocol Specification." The hub logs call this **HKSV3**.

New services, none of which exist in HAP-NodeJS:

| UUID | Service |
|---|---|
| `00008010` | `camera-capabilities` |
| `00008000` | `camera-buffer-management` |
| `00008031` | `camera-multi-tier-rtp-stream-management` |
| `00008032` | `camera-global-operating-mode` |
| `00008033` | `camera-webrtc-stream-management` |
| `00008021` | `camera-motion-zones` |
| `00008050` | `camera-key-management` |
| `00008080` | `camera-client-certificate-management` |

The `Version` characteristic on Camera Capabilities and Camera Motion Zones carries the
string `"17.99"` ("This version may be updated prior to release").

**Minimum requirements (spec §2).** The accessory must support at least three
concurrent video encodings per sensor. A fourth ("Highest") is allowed for 4K sensors
that can also emit 2K simultaneously.

| | 4K camera | 2K camera | 1080p camera |
|---|---|---|---|
| High | 4K @ 24 or 30 | 2K @ 24 or 30 | 1080p @ 30 |
| Medium | 1080p @ 30 | 1080p @ 30 | 720p @ 30 |
| Low | 360p @ 15 or 240p @ 30 | same | same |

16:9 resolutions: 4K → `3840×2160 / 1920×1080 / 640×360`; 2K → `2560×1440 / 1920×1080 / 640×360`;
1080p → `1920×1080 / 1280×720 / 640×360`. (The spec also tabulates 9:16, 4:3, 3:4 and 1:1.)

Target bitrates (aspect ratio is explicitly *not* a factor):

| Resolution | FPS | Avg kbps | Max kbps |
|---|---|---|---|
| 4K | 24/30 | 4500 | 5000 |
| 2K | 24/30 | 2800 | 3000 |
| 1080p | 30 | 1700 | 1800 |
| 720p | 30 | 768 | 800 |
| 360p/240p | 15/30 | 180 | 190 |

"The gap between maximum bitrate and average bitrate is recommended to be 10% or less
of the peak bitrate."

**Mandatory codecs.** HEVC for video. Opus for audio (16 kHz capture mandatory, 24 kHz
recommended; transmission always 48 kHz, and 48 kHz is what the characteristic must
report).

**Supported Video Stream Tiers** (`00008043`, tlv8) — this is the key structure:

```
1 Codec                  enum    1 = H.264, 2 = H.265
2 Payload Type           uint8
3 Tiers                  tlv8    repeated:
    1 Identifier             uint32
    2 Quality                enum   1=Highest 2=High 3=Medium 4=Low
    3 Target Average Bitrate uint32  (kbps)
    4 Width                  uint16
    5 Height                 uint16
    6 Frame Rate             uint8
```

**There is no profile field and no level field.** The controller then writes
`RTP Streaming Control` (`00008045`) naming a `Video Tier` identifier and an SSRC.
That is the entire negotiation.

Crucially, spec §4.3 says of its resolution table:

> "This list is not exhaustive of the resolutions that can be used. Your camera may
> provide other resolutions that are approximate to these values. The only required
> resolutions are those that are indicated in Section 2."

So advertising **2688×1512** as a High tier is legitimate under this spec, provided
the required Section 2 set is also offered.

**Recording** in the new model has two paths: the same HDS fMP4 bulk-send as classic
HKSV, or an optional **CMAF Ingest direct upload** where the camera PUTs clips to a
`Camera Recording Publishing Point` (`00008016`) using a client certificate it obtains
via CSR (`00008081`/`00008082`) and a key from Camera Key Management. Buffer commands
(`00008013` upload, `00008017` activity, `00008014` events) drive it.

**Remote viewing** is WebRTC (`00008033`) through Apple's relay with SFrame end-to-end
encryption layered on DTLS-SRTP. The call sequence is Solicit Offer → Provide Answer →
(Update Session / Reoffer) → Streaming Control: End.

---

## 3. The ten questions, answered

### Q1. What is the modern Homebridge 2.x camera plugin architecture?

A TypeScript + ESM **dynamic platform plugin**:

- `"type": "module"`, `main: dist/index.js`, build with plain `tsc` to `dist/`.
- `engines`: `node: ^22 || ^24`, `homebridge: ^2.0.0`.
- Default-export a registration function; `api.registerPlatform(...)`.
- Implement `DynamicPlatformPlugin`; restore cached accessories in
  `configureAccessory`; do discovery on `APIEvent.DID_FINISH_LAUNCHING`.
- **Import HAP types from `homebridge`, not from `@homebridge/hap-nodejs`.**
  Homebridge 2.4.0 re-exports the camera surface — verified in
  `homebridge/src/index.ts`: `CameraController` (:294), `CameraControllerEvents` (:250),
  `CameraControllerOptions` (:322), `CameraRecordingDelegate` (:324),
  `CameraStreamingDelegate` (:325).
  Keep `homebridge` as a `devDependency` + `peerDependency`, never a runtime dep.
- Attach the camera with `accessory.configureController(new CameraController(options))`.

The three delegate surfaces (`hap-nodejs/src/lib/controller/CameraController.ts`):

| Interface | Line | Responsibility |
|---|---|---|
| `CameraControllerOptions` | :42 | `cameraStreamCount`, `delegate`, `streamingOptions`, `recording?`, `sensors?` |
| `CameraStreamingDelegate` | :150 | `handleSnapshotRequest`, `prepareStream`, `handleStreamRequest` |
| `CameraRecordingDelegate` | :199 | `updateRecordingActive`, `updateRecordingConfiguration`, `handleRecordingStreamRequest`, `acknowledgeStream`, `closeRecordingStream` |

`handleRecordingStreamRequest` is an `AsyncGenerator<RecordingPacket>` and receives an
`AbortSignal` (added in #1110, 2026-03-20). Use it — that is the modern lifecycle hook.

`recording.options` is a `CameraRecordingOptions` (`RecordingManagement.ts:37`):
`prebufferLength` (≥4000 ms, 4000–8000 sensible), `overrideEventTriggerOptions?`,
`mediaContainerConfiguration` (fMP4, typically 4000 ms fragments), `video`, `audio`.

`EventTriggerOption.DOORBELL` exists but the doc comment warns HomeHubs never enable it
(`RecordingManagement.ts:77`, referencing HAP-NodeJS issue #976).

### Q2. What resolutions can `CameraController` advertise for live streaming?

**Effectively anything.** There is no enum and no whitelist:

```ts
// hap-nodejs/src/lib/camera/RTPStreamManagement.ts:302
export type VideoStreamingOptions = {
  codec: H264CodecParameters,
  resolutions: Resolution[],
  cvoId?: number,
}

// :319
export type Resolution = [number, number, number]; // width, height, framerate
```

The only validation before the wire is a length check:

```ts
// :1368-1388
videoOptions.resolutions.map(resolution => {
  if (resolution.length !== 3) { throw new Error("Unexpected video resolution"); }
  width.writeUInt16LE(resolution[0], 0);     // ≤ 65535
  height.writeUInt16LE(resolution[1], 0);    // ≤ 65535
  frameRate.writeUInt8(resolution[2], 0);    // ≤ 255
})
```

No clamping, no `Math.min`, no aspect-ratio check, no 1080p reference anywhere in the
streaming path. `3840×2160@30` encodes fine.

**This is already exercised in the wild.** `homebridge-unifi-protect@8.1.0` ships
these tables (`dist/media/resolution.js`):

```js
RESOLUTIONS_16X9 = [[3840,2160],[2560,1440],[1920,1080],[1280,720],[640,360],[480,270],[320,180]]
RESOLUTIONS_4X3  = [[3840,2880],[2560,1920],[1920,1440],[1280,960],[1024,768],[640,480],[480,360],[320,240]]
```

and `buildAdvertisedProfiles()` seeds the list with the camera's **native** top entry
before expanding the table, so on your G5 Bullets it is already advertising
`2688×1512@20` to Apple Home today.

**So advertisement is not the bottleneck. Selection is.** Apple requests ≤1080p on this
path regardless — consistent with your Scrypted observation of 1280×720@299 kbps and
640×360@132 kbps. See Q4 for why.

### Q3. What resolutions can `CameraRecordingDelegate` / HKSV advertise?

Identical situation. `VideoRecordingOptions` (`RecordingManagement.ts:118`) reuses the
same `Resolution` tuple and the same `H264CodecParameters`, and its TLV builder
(`:738`, writes at `:763-764`) is the same `writeUInt16LE` pair with no validation.

The only mention of 1080p in the entire `src/lib` tree is a **doc comment**:

```ts
// RecordingManagement.ts:122-123
/**
 * Required resolutions to be supported are:
 * * 1920x1080
 * * 1280x720
 * ...
 */
```

That is a *floor*, not a ceiling, and it is not enforced in code.

One asymmetry worth knowing about: the writer uses `writeUInt16LE` but the reader uses
**signed** `readInt16LE`:

```ts
// RecordingManagement.ts:660-661
const width  = videoAttributes[VideoAttributesTypes.IMAGE_WIDTH].readInt16LE(0);
const height = videoAttributes[VideoAttributesTypes.IMAGE_HEIGHT].readInt16LE(0);
```

Harmless for any real resolution (signed max 32767), but it means anything above 32767
would come back negative. Worth an upstream one-liner someday; not a blocker.

### Q4. Are there explicit 1080p limits anywhere?

**No explicit limit. One decisive implicit limit.**

```ts
// RTPStreamManagement.ts:69
export const enum H264Profile { BASELINE = 0x00, MAIN = 0x01, HIGH = 0x02 }

// RTPStreamManagement.ts:78
export const enum H264Level { LEVEL3_1 = 0x00, LEVEL3_2 = 0x01, LEVEL4_0 = 0x02 }
```

Level 4.0 is the top. H.264 Level 4.0 has `MaxFS = 8192` macroblocks. Frame sizes in
macroblocks:

| Resolution | MB cols × rows | Total MBs | Min level |
|---|---|---|---|
| 1280×720 | 80 × 45 | 3,600 | 3.1 |
| **1920×1080** | 120 × 68 | **8,160** | **4.0** ✅ (32 MBs of headroom) |
| 2560×1440 | 160 × 90 | 14,400 | 5.0 |
| **2688×1512** | 168 × 95 | **15,960** | **5.0** ❌ |
| 3840×2160 | 240 × 135 | 32,400 | 5.1 |

Level 4.0's `MaxFS` is, to within 0.4%, exactly 1080p. That is the ceiling, and it is
structural: an accessory that advertises `levels: [LEVEL4_0]` and a `2688×1512`
resolution is advertising a self-contradictory configuration, and iOS is entitled to
ignore the oversized entry — which is what it appears to do.

Codec type is the other implicit limit:

```ts
// RTPStreamManagement.ts:60
export const enum VideoCodecType {
  H264 = 0x00,
  // while the namespace is already reserved for H265 it isn't currently supported.
  // H265 = 0x01,
}
```

The classic path is **H.264 only**, by commented-out enum member.

### Q5. Has Homebridge / HAP-NodeJS implemented Apple's OS 27 changes?

**No.** Verified by direct UUID grep against `hap-nodejs/src` at v2.2.3 — all 8 new
service UUIDs and all 27 new characteristic UUIDs from Apple's spec return
`NOT FOUND`. Keyword scan: `Tier` 0 files, `WebRTC` 0 files, `HEVC` 0 files,
`CMAF` 0 files, `MultiTier` 0 files.

The most recent definitions update (`6ab369e`, 2026-07-08) added only
`SelectedSessionKeepaliveConfigurationList` (`00000275`) and
`SupportedSessionKeepaliveConfigurationList` (`00000274`) — unrelated.

**But there is in-flight upstream work, opened the same day as this research:**

> **homebridge/HAP-NodeJS#1132 — "HomeKit Secure Video 3 (iOS 27)"**
> by `seydx`, opened 2026-09-15, **draft**, `latest` ← `seydx:secure-video`.
> 3 commits, 21 files, **+5416 / −8**.

It adds `SecureVideoTypes.ts` (1260 lines), `SecureVideoController.ts` (1294 lines),
`CMAFIngest.ts` (418), `HDSSnapshotTransport.ts` (212), `SecureVideoCredentials.ts` (58),
plus ~660 lines of new characteristic/service definitions and ~500 lines of tests.
Its `VideoStreamTier` interface is `{ identifier, quality, targetAverageBitrate, width,
height, frameRate }` — free-form `number` width/height, no level.

The PR author's field notes are the most valuable part, and they are load-bearing for
this project:

- **"H.264 does not work on the remote WebRTC path, and it's the viewer, not the
  negotiation."** The Home app's `avconferenced` builds its receiver from a capability
  blob that is HEVC-only in every iOS 27 / tvOS 27 dump examined; an H.264 offer
  negotiates and then dies with `No matched feature list string for payload`. The
  author therefore routes H.264 cameras to the classic `CameraController`.
- **Secure-video services and a classic `CameraRTPStreamManagement` on the same
  accessory do not mix** — Home shows "No Response". One path or the other, per accessory.
- **fMP4 recording needs the `hvc1` sample entry**; with `hev1` the hub aborts after
  the third fragment. The hub also requires a `prft` box in front of each `moof` or
  `homed` crashes reading the fragment date.
- **CMAF direct upload is unverified** — provisioning works, but every PUT to the
  publishing point returns a bodyless 400.

Treat all of that as high-quality but unreplicated third-party reporting until we
reproduce it ourselves.

### Q5b. A strict plugin cannot import HAP's enums at all

Discovered while wiring the streaming delegate. `StreamRequestTypes`, `H264Profile`,
`H264Level` and `SRTPCryptoSuites` are declared as **ambient const enums** in
HAP-NodeJS's `.d.ts`. Homebridge re-exports them at runtime, but TypeScript refuses to
read an ambient const enum under `verbatimModuleSyntax` — TS2748 — so any plugin using
that setting cannot reference them as values.

The wire values are restated in `src/homekit/hap-constants.ts` with the reason recorded,
and the `StreamingRequest` union is narrowed by hand. Note also that `'video' in request`
does **not** discriminate that union: both the start and reconfigure variants carry
`video`, with different shapes.

One consequence worth knowing: HomeKit reports the profile and level it selected as
*indices into those enums*, not as H.264 wire values. Formatting them with an H.264
formatter produces nonsense such as `profile 2` and level `0.2`.

### Q6. What H.264 profiles/levels are permitted?

Advertise any subset of:

- **Profiles:** `BASELINE` (0x00), `MAIN` (0x01), `HIGH` (0x02)
- **Levels:** `LEVEL3_1` (0x00), `LEVEL3_2` (0x01), `LEVEL4_0` (0x02)

Packetization mode is fixed to `NON_INTERLEAVED` (0x00) and written unconditionally.
CVO is optional via `cvoId` (RTP extension id 1–14).

You advertise the set; **Apple selects one** and reports it back in
`StartStreamRequest.video` (`RTPStreamManagement.ts:509`), which carries
`codec, profile, level, packetizationMode, cvoId?, width, height, fps, pt, ssrc,
max_bit_rate, rtcp_interval, mtu`. Those fields are precisely the "HomeKit Request"
block of the diagnostics in §6.

Mid-session, Apple can send a `ReconfigureStreamRequest` carrying only
`{ width, height, fps, max_bit_rate, rtcp_interval }` (`:530`) — this is the adaptive
reconfiguration you saw in Scrypted, and it must be a first-class event in our
diagnostics, not a silent no-op.

For HKSV the selected configuration comes back as `SelectedH264CodecParameters`
(`RecordingManagement.ts:201`): `{ profile, level, bitRate, iFrameInterval }`.

### Q7. Can a plugin deliver an H.264 Protect stream directly without FFmpeg re-encoding?

**Yes — HAP-NodeJS never touches media bytes.** It performs key exchange and then gets
out of the way.

`prepareStream` receives (`RTPStreamManagement.ts:386`):

```ts
type PrepareStreamRequest = {
  sessionID, sourceAddress, targetAddress, addressVersion: "ipv4"|"ipv6",
  audio: Source, video: Source,
}
type Source = { port, srtpCryptoSuite, srtp_key: Buffer, srtp_salt: Buffer, ... }
```

and you answer with (`:412`, `:427`):

```ts
type PrepareStreamResponse = { addressOverride?, video: SourceResponse, audio?: SourceResponse }
interface SourceResponse { port, ssrc, srtp_key?, srtp_salt? }
```

That is the entire contract. **You** own the socket, the RTP packetization, the SRTP
encryption, and the RTCP. FFmpeg is one possible implementation of that, not a
requirement.

So a true passthrough path is:

```
Protect livestream (fMP4 over WebSocket)
  → demux moof/mdat, extract H.264 AVCC samples
  → convert AVCC → Annex-B, build SPS/PPS from the init segment's avcC
  → RTP-packetize per RFC 6184 (FU-A fragmentation at the negotiated MTU)
  → SRTP-encrypt with the keys from PrepareStreamRequest
  → UDP to targetAddress:port
```

Two real constraints to design around:

- **`unifi-protect` v5 gives you fMP4, not Annex-B.** `Segment` is
  `{type:"init", data, codec} | {type:"media", data, moof, mdat, timestamps?, discontinuity?}`
  (`transport/livestream-session.d.ts`). We must write the AVCC→Annex-B and RTP
  packetization ourselves. This is the main piece of genuinely new code in the project.
  The alternative is Protect's RTSPS endpoint (TCP 7441), which gives RTP directly but
  costs a separate session and its own failure modes.
- **Keyframe cadence.** `VideoInfo`'s comment notes "minimum keyframe interval is about
  5 seconds". Protect's native GOP must be compatible or time-to-first-frame suffers.
  Instrument this (§6).

### Q8. What work is needed to expose the G5 Bullet's native 2688×1512 to Apple Home?

Two routes. They are not equally promising.

**Route A — classic path, upstream level change.**

1. Advertise `[2688, 1512, 20]` in `streamingOptions.video.resolutions`. *Already
   possible; needs no change to anything.*
2. Add `LEVEL5_0` (and probably `LEVEL5_1`) to `H264Level`. This is mechanically a
   3-line change to `RTPStreamManagement.ts:78`, and because it is a `const enum`
   erased at compile time, a plugin can already pass `3 as H264Level` to emit an
   unnamed wire value without touching upstream at all.
3. …and that is where it stops being a plan. **The HAP spec's level enum has no
   published value above 2.** `0=3.1, 1=3.2, 2=4.0` is the entire public namespace.
   Emitting `3` is guessing at a value Apple may not define, may define differently,
   or may reject outright. There is no evidence anywhere that iOS requests >1080p on
   the classic path even when offered.

   **Route A is a 30-minute experiment, not an architecture.** Worth running in Phase 5
   for the data. Do not build on it.

**Route B — HKSV3 tier model.** The new `Supported Video Stream Tiers` TLV has
`Width uint16`, `Height uint16`, `Frame Rate uint8`, `Target Average Bitrate uint32`,
and **no profile and no level**. The level constraint that creates the 1080p ceiling
simply does not exist in this structure. Apple's own text permits "other resolutions
that are approximate to these values."

So `2688×1512@20` at ~3000 kbps, advertised as `Quality = High (2)` alongside the
required 2K-camera Medium (`1920×1080@30`) and Low (`640×360@15`) tiers, is a
well-formed advertisement under the published spec.

What it requires:

1. HAP-NodeJS gains the OS 27 services — i.e. PR #1132 lands, or we vendor/fork
   equivalent support. **This is the single upstream dependency.**
2. For **local** viewing, the tier codec enum includes `H264 = 1`, so H.264 may work.
   Unverified.
3. For **remote** viewing, plan on **HEVC**. The spec mandates it; the PR author's
   traces say the iOS 27 receive path is HEVC-only in practice.
4. Audio becomes **Opus**, not AAC-ELD. 16 kHz capture, reported as 48 kHz, 20 ms
   packets, mono.
5. Recording fMP4 must use `hvc1` (not `hev1`) and include a `prft` box before each
   `moof`.

**Recommendation: build Route B's *shape* now, run Route A's *experiment* in Phase 5.**
Specifically: design the stream broker and capability model around tiers from day one
(they map 1:1 onto Protect's High/Medium/Low), and render them through the classic
`CameraController` today. When #1132 lands, adding a `SecureVideoController` becomes
a new renderer over the same capability model rather than a rewrite.

### Q9. What prevents this today?

In descending order of how hard they are to move:

1. **HAP-NodeJS 2.2.3 contains no OS 27 camera code at all.** (Verified. Draft PR #1132
   exists, opened today, not merged, explicitly incomplete on CMAF upload.)
2. **Apple's iOS 27 remote path appears to be HEVC-only**, per the PR author's
   sysdiagnose analysis. We cannot fix that; we can only supply HEVC.
3. **The G5 Bullets are currently emitting H.264.** Whether they *can* emit H.265 is
   unverified and is the highest-value open question in this document (§8.1).
4. **The classic path is level-capped at 4.0 = 1080p**, and Apple appears not to request
   above 1080p there regardless of advertisement.
5. **You cannot mix classic and secure-video services on one accessory** — "No Response".
   So this is a per-accessory mode switch, which argues for making the renderer
   pluggable rather than conditional-branching inside one camera class.

Note what is *not* on this list: Homebridge, HAP-NodeJS resolution validation, TLV
encoding width, and the `unifi-protect` library. None of those are in the way.

### Q10. What of `unifi-protect` v5 should we use rather than reimplement?

**Use it for everything except media transformation.** Version 5.3.1 is ESM, has exactly
one runtime dependency (`undici`), targets Node ≥22.20, and is architecturally aligned
with what this project wants.

**Use as-is:**

| Area | API |
|---|---|
| Connection | `ProtectClient.connect({host, username, password, signal, verifyTls, recoveryPolicy, refreshIntervalMs})` — authenticates, bootstraps, opens realtime, returns ready. `AsyncDisposable`. |
| Discovery | `client.cameras`, `client.camera(id)`, plus `chimes/fobs/lights/relays/sensors/viewers` |
| State | `createStateStore`, `deviceSelectors`, `isDeviceOnline`, `isDeviceAdopted`, `selectNvr`, `selectIsAdmin`, … — reducer over the realtime packet stream |
| Realtime | `client.events({signal})` → `AsyncGenerator<TypedEvent>`; `client.on("packet")`; `SmartDetectType` |
| Livestream | `camera.livestream(opts)` → `LivestreamSubscription`, which is `AsyncIterable<Segment>` **and** `AsyncDisposable`, with `.codec`, `.initSegment`, `.state`, `.stats` |
| Multiplexing | `LivestreamPool` — already dedupes subscribers per `(cameraId, channel/lens)`. **This is most of our stream broker.** `urgency()` lets consumers weight themselves. |
| Recovery | `RecoveryPolicy` / `defaultLivestreamRecoveryPolicy`, `RecoveryContext`, `RecoveryDecision` |
| Errors | Typed tree: `RecoverableError` vs `FatalError`, with `ProtectCodecChangeError`, `ProtectStallError`, `ProtectLivestreamUnavailableError`, `ProtectThrottledError`, `ProtectAuthError`, … |
| Snapshots | `camera.snapshot({width, height, packageCamera, signal})` |
| Talkback | `camera.talkback({signal})` → `TalkbackSession` (Phase 7) |
| Diagnostics | `channels` / `subscribeToChannel` with ~28 typed payloads including `LivestreamCodecChangedPayload`, `LivestreamStallDetectedPayload`, `HttpThrottleEnteredPayload` — **feed these straight into our metrics (§6)** |
| Types | `ProtectCameraConfig`, `ProtectCameraChannelConfig` (`{width,height,fps,fpsValues,bitrate,autoBitrate,autoFps,enabled,…}`), `featureFlags.videoCodecs: string[]`, `videoCodec: string` |

**Write ourselves:**

- fMP4 → Annex-B demux, RTP packetization (RFC 6184 / RFC 7798 for HEVC), SRTP.
- HKSV prebuffer + fragment assembly (`unifi-protect` gives segments, not an HKSV buffer).
- The HomeKit capability/tier model and the stream selector.
- Hardware-acceleration abstraction and any FFmpeg lifecycle.

**Do not** fork `homebridge-unifi-protect`. Study it — especially
`media/timeshift.js`, `media/timeshift-supervisor.js`, `media/record.js`,
`media/livestream-recovery-policy.js`, `media/stream-source-policy.js` — and take the
lessons, not the code. Note that 8.1.0 pins `unifi-protect@5.2.0` while 5.3.1 is
current; we should track 5.3.1.

One directly reusable insight from its source: `media/stream.js:384` forces transcoding
when `videoCodec !== "h264"`, which is the exact shape of the classic path's H.264-only
constraint showing up in a real plugin.

---

## 4. The G5 Bullet decision tree

Everything downstream of this project's central goal turns on one unverified fact.

```
Does the G5 Bullet report "h265" in featureFlags.videoCodecs?
│
├─ NO  → OS 27 max-resolution HKSV is out of reach for these cameras.
│        Build the best possible classic-path plugin:
│          • direct H.264 passthrough, no FFmpeg in the happy path
│          • advertise native 2688×1512 (costs nothing, may become useful)
│          • excellent diagnostics + HKSV reliability
│        Revisit if/when a G6 (HEVC) camera enters the fleet.
│
└─ YES → Switch Protect to Enhanced (H.265) encoding and:
           • classic path now REQUIRES transcoding (HAP classic is H.264-only)
             → passthrough-first is violated on the classic path
           • HKSV3 path becomes natively possible once #1132 lands
             → passthrough-first is FULLY satisfied, at native resolution
         This is a real trade: H.265 costs you today's passthrough to buy
         tomorrow's native 2K/native-resolution path.
```

**Important tension to name explicitly:** the brief's two headline goals —
*passthrough-first* and *maximum OS 27 resolution* — are in direct conflict for a G5
Bullet on H.264 today. H.264 passthrough works but is capped at 1080p by level. Native
resolution requires the tier model, which effectively requires HEVC, which the classic
path cannot pass through at all. There is no configuration that delivers both until
HKSV3 support exists in HAP-NodeJS.

A secondary wrinkle: Apple's 2K profile wants **2560×1440**; the G5 Bullet's native is
**2688×1512**. Apple permits "approximate" resolutions, so 2688×1512 should be
advertisable — but if it is rejected in testing, matching 2560×1440 exactly would mean
either reconfiguring the Protect channel (check `channels[].width/height` for what the
camera actually offers) or rescaling, which is a transcode.

### 4.1 Measured capability — answered 2026-09-16

Probed against the live controller (UDW "Dream Wall", Protect 7.2.105). Both cameras
report identically:

```
UVC G5 Bullet — firmware 5.4.132
  active codec  : h264
  supports      : h264, h265, mjpg     ← HEVC capable
  channels:                     configured / channel ceiling
    High     2688×1512 @ 20fps   8.0 / 10.0 Mbps   rtsp:on
    Medium   1280× 720 @ 30fps   2.0 /  2.0 Mbps   rtsp:on
    Low       640× 360 @ 30fps   0.4 /  1.0 Mbps   rtsp:on
  fps menu      : 30, 25, 24, 20, 18, 16, 15, 12, 10, 9, 8, 6, 5, 4, 3, 2, 1
                  (identical on all three channels — 24 and 30 are available on High)
  2560×1440     : not offered
  mic           : yes   (featureFlags.hasMic)
  speaker       : no    (false at both featureFlags.hasSpeaker and camera.hasSpeaker)
  audio codecs  : aac, opus
  smart detect  : person, vehicle, animal
```

> **Two bitrates, not one.** Protect reports both a *configured* `bitrate` and a higher
> `maxBitrate` channel ceiling. Quoting one without saying which makes two tools disagree
> about the same camera — which is exactly what happened here between the probe and the
> plugin. Phase 2's bitrate decisions need the configured figure (what the camera actually
> sends); the ceiling only bounds what it could be raised to. `describeTier()` prints both.

> **Probe caveat worth remembering.** `hasMic` exists *only* under `featureFlags`, while
> `hasSpeaker` exists both there and at the top level. Reading `hasMic` from the top level
> yields `undefined`, which is falsy — so a naive probe reports "no microphone" for a
> camera that has one. `scripts/protect-probe.sh` now prints the raw value and `ABSENT`
> rather than coercing to yes/no, and `readCapabilities()` reads each flag from where it
> actually lives.

#### Audio

**Microphone yes, speaker no.** That splits cleanly across the phases:

- **Phase 2/4 (live audio, HKSV audio): viable.** The camera captures audio and Protect
  offers both `aac` and `opus`.
- **Phase 7 (two-way audio): not on these cameras.** There is no speaker, so there is
  nothing to talk back through. Protect still reports a `talkbackSettings` block
  (`aac 22050 Hz, mono, port 7004`), but that is a default, not evidence of hardware —
  do not treat its presence as a capability signal.

The `opus` availability is a quiet win for the HKSV3 path: Apple's iOS 27 spec makes Opus
**mandatory** for secure video, 16 kHz capture, reported as 48 kHz. The camera can already
produce it, so that requirement costs us nothing when the time comes.

#### Smart detections

`person`, `vehicle`, `animal`. No `package`, `face` or `licensePlate` — expected, since
these are bullets rather than doorbells. Phase 3 maps exactly these three and must not
assume the others exist.

**The decision tree resolves to the YES branch — but the timing matters, and the answer
is "not yet".**

HEVC being available does not mean switching to it now. The classic `CameraController`
path is H.264-only (`VideoCodecType.H265` is a commented-out enum member), so flipping
Protect to Enhanced encoding today would force a transcode on *every* stream, violating
passthrough-first in exchange for a benefit that does not exist until HAP-NodeJS gains
HKSV3 support. **Stay on H.264. Revisit the moment PR #1132 lands.**

#### What passthrough gets us today

This is better than expected. Apple Home's two commonly-observed requests both map to a
native channel with RTSP already enabled:

| HomeKit asks for | Native channel | Action |
|---|---|---|
| 1280×720 | **Medium**, 1280×720 H.264 | direct passthrough |
| 640×360 | **Low**, 640×360 H.264 | direct passthrough |

Both are exact matches, so Phase 2 should reach `Mode: Direct H.264 Passthrough` on the
common case immediately — no resolution compromise, no FFmpeg.

One caveat for the stream selector: Medium is capped at 2.0 Mbps while HomeKit typically
requests ~299 Kbps. Passing through a stream that overshoots the negotiated
`max_bit_rate` is a protocol problem, not a quality win. Protect exposes per-channel
bitrate, so the options are (a) lower the Medium channel's cap once, (b) adjust it
dynamically per session — which affects every other consumer of that channel, so
probably not — or (c) accept the overshoot on local networks and log it. Decide in
Phase 2 with real measurements.

#### The 20 fps problem — resolved

HomeKit expects 15, 24 or 30 fps; the High channel ships at **20**.
`homebridge-unifi-protect` works around this by advertising a normalised rate and
delivering the real one (`buildAdvertisedProfiles` maps 20 → 24). That is a lie to the
controller and we do not repeat it.

Per-channel `fpsValues` confirms **24 and 30 are both available on the High channel**, so
the honest fix is a one-line Protect change: **set High to 24 fps** (matching Apple's
"2K at 24 or 30fps" requirement) and advertise what we actually send.

Until that change is made, `hasConformingFrameRate()` flags the mismatch and
`conformingAlternatives()` reports what the channel could be set to, so the plugin
surfaces the problem instead of hiding it.

#### The 1080p ceiling applies to recording too — verified 2026-09-18

The ceiling is `H264Level.LEVEL4_0` in the live streaming path, so it was reasonable to
wonder whether HKSV recording, which negotiates separately through `RecordingManagement`,
escapes it. It does not.

Measured against the incumbent plugin on this hardware: it advertised
`HKSV: 2688x1512@30fps (High) [H264], 2 Mbps` and offered the 2K channel as the source,
but a recorded event exported from the Home app came back **1920×1080**, H.264, AAC mono.
Apple negotiates the recording down to the same ceiling.

So nothing on the classic path reaches 2688×1512, for live view or for recording, in any
plugin. Route B (HKSV3, whose tier model has no level field) remains the only way up, and
it remains blocked on HAP-NodeJS.

#### Gaps against Apple's HKSV3 tier profile (for later)

Apple classifies this as a **2K camera**. Measured against that profile:

| Tier | Apple requires | G5 Bullet has | Verdict |
|---|---|---|---|
| High | 2560×1440 @ 24/30, ≤3000 kbps | 2688×1512 @ 20, 8000 kbps (ceiling 10000) | resolution OK as "approximate"; **fps and bitrate out of spec** |
| Medium | 1920×1080 @ 30, ≤1800 kbps | 1280×720 @ 30, ≤2000 kbps | **720p where 1080p is expected** |
| Low | 640×360 @ 15 (or 240p @ 30), ≤190 kbps | 640×360 @ 30, ≤400 kbps | resolution exact; bitrate high |

Three things to note:

1. **No 2560×1440 channel exists**, and Protect's channel set is fixed per camera model —
   there is no resolution picker. So 2688×1512 must be advertised as the approximate
   High tier (spec §4.3 explicitly permits this) or rescaled, which is a transcode.
2. **Medium at 720p is the one structural gap.** The G5 Bullet's Medium/Low pair exactly
   matches Apple's *1080p-camera* profile, not its 2K profile. Either advertise 720p as
   Medium and see whether the hub accepts it, or synthesise a 1080p Medium by transcoding
   from High — which costs the passthrough property on that tier.
3. **Bitrates are well above Apple's targets**, but Apple's numbers assume HEVC. 2688×1512
   HEVC at ~3 Mbps is roughly quality-equivalent to today's 8 Mbps H.264, so conforming
   is close to free *once we are on HEVC anyway*. Do not lower it while still on H.264.


---

## 5. Recommended architecture

### 5.1 Layering

```
┌─ platform ──────────────────────────────────────────────┐
│  ProtectPlatform (DynamicPlatformPlugin)                │
│  ProtectClient lifecycle, discovery, accessory cache    │
└───────────────┬─────────────────────────────────────────┘
                │
┌─ per-camera ──▼─────────────────────────────────────────┐
│  CameraCapabilityModel   ← tiers derived from Protect   │
│  StreamBroker            ← wraps LivestreamPool         │
│  SnapshotService         ← coalescing + cache           │
│  EventRouter             ← realtime → HomeKit           │
│  SessionMetrics          ← diagnostics                  │
└───────────────┬─────────────────────────────────────────┘
                │
┌─ renderers (pluggable, one active) ─────────────────────┐
│  ClassicRenderer   → CameraController (today)           │
│  SecureVideoRenderer → SecureVideoController (when #1132)│
└─────────────────────────────────────────────────────────┘
```

The **capability model is the spine**. It is expressed in tier terms — `{quality,
codec, width, height, fps, avgBitrate, peakBitrate, protectChannel}` — derived from
`ProtectCameraChannelConfig[]`. The classic renderer flattens it into a
`Resolution[]` + `H264CodecParameters`; a future secure-video renderer emits it almost
verbatim as `SupportedVideoStreamTiers`. That is what keeps HKSV3 adoption from being
a rewrite.

### 5.2 Stream selection preference order

Per the brief, with the level constraint folded in:

1. **Exact native match** — requested W×H equals a Protect channel's W×H, codec H.264 → direct passthrough.
2. **Closest native ≥ request, repacketizable** — only when HomeKit tolerates the dimension mismatch. Never silently scale.
3. **Closest native requiring minimal conversion** (e.g. bitrate cap only).
4. **VideoToolbox transcode** (`h264_videotoolbox` / `hevc_videotoolbox`; confirmed available here).
5. **`libx264` software** — last resort, logged as a warning.

In **Maximum HomeKit Quality** mode: advertise every legitimate resolution, always
prefer the highest-quality compatible Protect source, never voluntarily drop to
Medium/Low for bandwidth, and use the highest bitrate the negotiation permits — but
**never exceed what Apple selected**. `max_bit_rate` from `StartStreamRequest` is a
protocol constraint, not a suggestion.

### 5.3 Stream broker

`unifi-protect`'s `LivestreamPool` already does per-`(camera, channel)` dedup with
recovery policy and an `urgency()` hook. Our broker sits on top and adds:

- **Fan-out to multiple consumer types** from one subscription: live session, HKSV
  recorder, snapshot extractor, thumbnail.
- **Rolling prebuffer** (ring buffer of fMP4 segments, ≥ `prebufferLength`, keyframe-aligned).
- **Reference counting with lazy teardown** — do not tear down the High channel the
  instant a live view closes if HKSV is armed.
- **Codec-change handling** — subscribe to `LivestreamCodecChangedPayload` and
  `ProtectCodecChangeError`; a mid-stream codec switch must invalidate the prebuffer
  and restart cleanly rather than emit corrupt fragments.

Only open channels that have a live consumer, except the one channel HKSV needs armed.

### 5.4 Snapshots

- Prefer extracting a keyframe from an already-running prebuffer (near-zero cost).
- Fall back to `camera.snapshot({width, height, signal})`.
- **Coalesce** identical concurrent requests behind a single in-flight promise keyed by
  `(cameraId, width, height)` — Home requests every tile at once.
- Keep a short-lived cached frame (a few seconds) so a transient Protect failure shows
  a slightly stale image rather than "No Response".
- **Bound every snapshot against HomeKit's deadline.** HAP-NodeJS warns at 8000 ms
  (raised in #1055). mp-consulting hit this hard enough to commit "Bound snapshot
  sources against the HomeKit deadline" (2026-08-03) — take that lesson for free.

---

### 5.5 Matter: not for the cameras

Homebridge 2.x ships Matter support (`@matter/main` 0.17.9, `api.matter`), so the
question is live. **Decision: do not expose Protect cameras over Matter.** Three
reasons, in descending order of finality:

1. **Apple Home does not support Matter cameras.** Cameras remain one of the notable
   absences from Apple's Matter implementation, and everything camera-related in iOS 27
   — including the 4K work this project is chasing — is HAP/HKSV, not Matter. A Protect
   camera published over Matter would be invisible in the only app we are targeting.
2. **HKSV is a HAP feature.** Matter's recording analogue is `PushAvStreamTransport`,
   which pushes to an endpoint you operate. It is not HKSV: no Home-app camera
   timeline, no iCloud clip storage, none of the iOS 27 clip descriptions or event
   search. Recording is the point of this plugin.
3. **Homebridge does not expose a camera device type.** Its curated
   `deviceTypes` map (`src/matter/types.ts`) has 28 entries — lights, switches,
   outlets, sensors, thermostat, fan, lock, covering, closure, media player, speaker,
   vacuum, valve, generic switch, pump, room AC, bridged node. No camera, no doorbell.

   Note this is soft: `MatterAccessory.deviceType` is typed as matter.js's generic
   `EndpointType` (`src/matter/types.ts:204`), not as a key of that map, so a plugin
   *could* pass `CameraDevice` from `@matter/main/devices/camera`. matter.js 0.17.9
   does ship `camera`, `snapshot-camera`, `floodlight-camera` and `video-doorbell`
   device types plus the `CameraAvStreamManagement`, `WebRtcTransportProvider`,
   `WebRtcTransportRequestor`, `PushAvStreamTransport` and `ZoneManagement` clusters.
   The stack is there. There is simply no controller on the other end that cares.

**The finding worth keeping.** Matter's camera model and Apple's HKSV3 are the *same
shape*. matter.js composes its Camera device type as
`CameraAvStreamManagement.with("Video","Audio","Snapshot")` + `WebRtcTransportProvider`
+ `WebRtcTransportRequestor` + `PushAvStreamTransport` + `ZoneManagement` +
`CameraAvSettingsUserLevelManagement`. Apple's HKSV3 is Camera Multi-Tier RTP Stream
Management + Camera WebRTC Stream Management + CMAF upload via Buffer Management +
Camera Motion Zones. Two standards bodies, independently, landed on the same four
concepts: **declare stream capabilities and let the controller allocate one; WebRTC for
viewing; push/upload for recording; polygonal zones for motion.**

That is strong independent support for §5.1's central bet — make the tier/capability
model the spine and the wire protocol a renderer. If Apple ever ships Matter camera
support, `MatterRenderer` slots in beside `ClassicRenderer` and `SecureVideoRenderer`
over an unchanged capability model.

**Where Matter may earn its place later (Phase 7+).** The *non-camera* Protect estate
maps cleanly onto device types Homebridge already exposes: motion and contact sensors,
leak/smoke sensors, chimes (Speaker), floodlights (DimmableLight), doorbell button
(GenericSwitch), relays (OnOffOutlet). Publishing those over Matter would reach
Alexa/Google/SmartThings at near-zero architectural cost and with none of the camera
problems. Strictly additive; must not touch the video path.

## 6. Diagnostics (first-class)

Every session emits one structured record. Target output:

```
HomeKit Request        Protect Source          Delivery
  Resolution 1280×720    Stream     High         Mode      Direct H.264 Passthrough
  FPS        30          Resolution 2688×1512    Transcode No
  Bitrate    299 Kbps    FPS        20           Startup   142 ms
  Profile    Main        Bitrate    4.7 Mbps     TTFF      118 ms
  Level      4.0         Codec      H.264        TTFK       96 ms
  Dest       Local       Channel    0
```

Fields to capture per session:

| Group | Fields | Source |
|---|---|---|
| Request | `width, height, fps, max_bit_rate, profile, level, pt, ssrc, mtu, rtcp_interval` | `StartStreamRequest.video` (`RTPStreamManagement.ts:509`) |
| Reconfigure | `width, height, fps, max_bit_rate` + timestamp, **appended not overwritten** | `ReconfiguredVideoInfo` (`:530`) |
| Source | Protect channel id/name, `width, height, fps, bitrate`, codec | `ProtectCameraChannelConfig` |
| Delivery | `direct` \| `remux` \| `hw-transcode` \| `sw-transcode`, decoder, encoder | our selector |
| Timing | time-to-first-RTP, time-to-first-keyframe, total startup | our pipeline |
| Health | dropped frames, transcode fps, RTCP loss, stream errors, restarts | ours + `unifi-protect` diagnostics channels |

Surface it three ways: a one-line INFO summary per session, the full record at DEBUG,
and — since `homebridge-unifi-protect` demonstrates the pattern with
`@homebridge/plugin-ui-utils` — a live panel in the plugin UI later.

Make the reconfigure history explicit. Apple's adaptive downshift from 720p to 360p is
exactly the behaviour we are trying to understand under OS 27, and a record that only
shows the final state hides it.

---

## 7. Proposed repository structure

### Phase 1 — Protect discovery, no video

```
homebridge-unifi-protect-hksv/
├── package.json                     # ESM, node ^22||^24, homebridge ^2.0.0 peer
├── tsconfig.json                    # strict, NodeNext, target ES2023, outDir dist/
├── eslint.config.js
├── config.schema.json               # Homebridge UI config
├── ARCHITECTURE.md
├── README.md
└── src/
    ├── index.ts                     # registerPlatform entry
    ├── settings.ts                  # PLATFORM_NAME, PLUGIN_NAME, constants
    ├── platform.ts                  # ProtectPlatform: DynamicPlatformPlugin
    ├── config.ts                    # typed config + validation/defaults
    ├── protect/
    │   ├── controller.ts            # ProtectClient lifecycle, reconnect, dispose
    │   ├── discovery.ts             # bootstrap → camera set, add/remove reconcile
    │   ├── events.ts                # realtime → typed internal events
    │   └── capabilities.ts          # ProtectCameraConfig → CameraCapabilityModel
    ├── accessories/
    │   ├── accessory-cache.ts       # configureAccessory / UUID / context versioning
    │   ├── camera-accessory.ts      # thin; composes services, owns no video
    │   └── services/
    │       ├── accessory-info.ts
    │       ├── motion.ts
    │       └── occupancy.ts
    ├── core/
    │   ├── logger.ts                # scoped, level-aware
    │   ├── lifecycle.ts             # AbortController helpers, disposal registry
    │   └── result.ts                # typed error handling
    └── types/
        └── index.ts
```

Phase 1 exit criteria: cameras appear in Home, online/offline tracks Protect, motion
fires from realtime events, accessories survive restart from cache, clean shutdown with
no leaked sockets or timers.

### Phase 2 — Live video, passthrough-first

Adds:

```
src/
├── media/
│   ├── broker/
│   │   ├── stream-broker.ts         # per-camera; wraps LivestreamPool
│   │   ├── subscription.ts          # ref-counted consumer handle
│   │   └── prebuffer.ts             # rolling keyframe-aligned ring buffer
│   ├── fmp4/
│   │   ├── demux.ts                 # moof/mdat → samples
│   │   ├── avcc.ts                  # avcC parse, AVCC → Annex-B, SPS/PPS
│   │   └── init-segment.ts          # codec/dimension/timescale extraction
│   ├── rtp/
│   │   ├── h264-packetizer.ts       # RFC 6184, FU-A at negotiated MTU
│   │   ├── srtp.ts                  # AES_CM_128_HMAC_SHA1_80
│   │   ├── rtcp.ts                  # SR/RR, keepalive
│   │   └── sender.ts                # UDP socket lifecycle
│   ├── select/
│   │   ├── capability-model.ts      # the tier spine
│   │   ├── stream-selector.ts       # the 5-step preference order
│   │   └── quality-mode.ts          # Maximum HomeKit Quality
│   └── transcode/
│       ├── hwaccel.ts               # platform probe: VideoToolbox / VAAPI / none
│       └── ffmpeg-session.ts        # spawn/kill/backpressure (Phase 6; stub here)
├── homekit/
│   ├── renderers/
│   │   ├── renderer.ts              # interface both renderers implement
│   │   └── classic-renderer.ts      # CameraController wiring
│   ├── streaming-delegate.ts        # CameraStreamingDelegate
│   └── snapshot-delegate.ts
└── diagnostics/
    ├── session-metrics.ts           # the §6 record
    ├── session-report.ts            # formatting
    └── protect-channels.ts          # unifi-protect diagnostics → our metrics
```

Phase 2 exit criteria: one G5 Bullet live-streams to Home with **zero FFmpeg processes
spawned** in the happy path; every session logs a complete diagnostic showing
`Mode: Direct H.264 Passthrough`; measured time-to-first-frame recorded as the baseline
all later changes are compared against.

> **Met 2026-09-16.** Live video confirmed in the Home app against a G5 Bullet, with no
> perceptible delay on opening the tile.
>
> | Baseline | |
> |---|---|
> | Delivery | `Direct H.264 Passthrough`, no transcode |
> | FFmpeg processes | 0 |
> | Time to first RTP | **235 ms** (476 ms on a cold Protect session) |
> | Time to first keyframe | 235 ms |
> | Session | 258 frames, 3 keyframes, 469 packets, 358.7 KB, 0 send errors |
> | Negotiated | 1280×720@30 / 299 Kbps → Medium channel, exact match |
> | Adaptation | stepped to 640×360 / 132 Kbps at ~4.5 s |
>
> Compare every later change against 235 ms. A regression here is the first signal that
> something has been added to the hot path.

`src/homekit/renderers/renderer.ts` is deliberately introduced in Phase 2 even though
there is only one implementation. It is the seam that makes a future
`secure-video-renderer.ts` additive.

---

## 8. Open questions — verify before designing further

### 8.1 Do the G5 Bullets support H.265? — ANSWERED

**Yes.** Both report `videoCodecs: [h264, h265, mjpg]`. Full measurements, the resulting
decision and the gaps against Apple's tier profile are in **§4.1**.

Reusable probe (prompts for the password; never places it in argv, shell history or on
disk): `scripts/protect-probe.sh`.

### 8.2 Will iOS request >1080p on the classic path if offered an out-of-spec level?

Cheap experiment (Phase 5): advertise `2688×1512` with `levels: [LEVEL4_0]`, then with
`3 as H264Level`, and log exactly what `StartStreamRequest.video` comes back as. Either
outcome is useful data and it costs half an hour.

### 8.3 Does PR #1132 land, and in what shape?

It is a draft with a self-declared unverified CMAF path. Track it. If it stalls, the
fallback is vendoring `SecureVideoTypes.ts` + `SecureVideoController.ts` behind our
renderer interface — which is a strong argument for having that interface from Phase 2.

### 8.4 Can 2688×1512 be advertised as a tier, or must it be exactly 2560×1440?

Untestable until §8.3 resolves. Apple's text permits approximate resolutions; the
practical answer needs a real hub.

### 8.5 Protect fMP4 → RTP fidelity — largely answered 2026-09-16

Verified against a live G5 Bullet. Live video reaches the Home app as
`Direct H.264 Passthrough`, first RTP packet at 235 ms, no FFmpeg process.

Measured facts:

- **Media timescale is 90000** — identical to RTP's video clock, so the timestamp
  conversion is one-to-one.
- The init segment carries **1 SPS and 1 PPS** in `avcC`, and in-band parameter sets are
  absent, so `withParameterSets()` is load-bearing rather than defensive.
- **Apple adapts downward within seconds.** A session negotiated at 1280×720 / 299 Kbps
  was reconfigured to 640×360 / 132 Kbps about 4.5–5 s in, every time. This is the
  behaviour observed in Scrypted, now visible in our own diagnostics.
- Codec string is `avc1.4d401f,mp4a.40.2`: **Main profile, level 3.1**, plus AAC.

Two traps, both of which cost a debugging cycle and neither of which is visible in the
library's types:

1. **`Segment.mdat` is the mdat box *header*, not the payload.** The library assembles a
   segment as `[moof][mdat header][video][audio]` and slices `mdat` from the header
   frames alone. The samples are in `Segment.data`. Feeding `mdat` to a NAL walker yields
   exactly zero frames.
2. **Video and audio share one `mdat`.** An earlier design note here claimed the sample
   table could be skipped entirely, because AVCC samples are self-delimiting. That is
   true only if the `mdat` holds nothing else. It holds AAC too, and walking the whole
   payload read ~10% of it as a spurious extra picture — which made the access-unit count
   disagree with the controller's timestamps and silently dropped the stream onto
   synthesised timing. `trun` parsing is required; `media/fmp4/moof.ts` does it, keyed on
   the video track id from the init segment's `tkhd`.

**B-frames: none.** Every `trun` composition offset measured is zero, so decode order
equals presentation order on this camera. The offsets are parsed and applied anyway
(`media/fmp4/moof.ts`), since a camera that did use them would otherwise play pictures out
of order — but on a G5 Bullet the code is a no-op.

**SRTCP sender reports: required in practice.** Without them HomeKit renegotiated every
session from 1280×720 down to 640×360 within about five seconds. With them it holds 720p
for the length of the session. A receiver decodes RTP without sender reports but cannot
map the media clock to wall time, so its jitter buffer is left estimating.

**Do not starve the encoder to fit HomeKit's bitrate.** Protect's floor for the Medium
channel is 750 Kbps, still well above the ~299 Kbps HomeKit negotiates for 720p — so
passthrough can never match the negotiated ceiling on this hardware. Capping Medium at its
750 Kbps floor to narrow the gap made things *worse*: the static parts of the frame stayed
sharp while anything moving smeared, because the encoder had no bits left for motion. That
presents almost exactly like packet loss and is not. Left at 2.0 Mbps the stream is smooth
and HomeKit does not complain, despite sending roughly 525 Kbps against a 299 Kbps
ceiling. The negotiated bitrate is a ceiling HomeKit tolerates being exceeded on a local
network; encoder quality is not recoverable once thrown away.

Still open: the native GOP length, and a small output jitter buffer to absorb the
occasional late segment (Protect delivers ~3 pictures per 100 ms, so a late one shows as a
brief hold followed by a catch-up).

---

## 9. Sources

**Apple**
- *HomeKit Secure Video Open Source Compatibility Guide*, v1.0, 2026-06-03, Developer Preview — [developer.apple.com](https://developer.apple.com/download/files/HomeKit-Secure-Video-Open-Source-Compatibility-Guide.pdf)

**HAP-NodeJS v2.2.3** (`25e8bea`) — github.com/homebridge/HAP-NodeJS
- `src/lib/camera/RTPStreamManagement.ts` — `VideoCodecType`:60, `H264Profile`:69, `H264Level`:78, `VideoStreamingOptions`:302, `H264CodecParameters`:311, `Resolution`:319, `PrepareStreamRequest`:386, `PrepareStreamResponse`:412, `SourceResponse`:427, `StartStreamRequest`:462, `VideoInfo`:509, `ReconfiguredVideoInfo`:530, TLV builder:1345-1392
- `src/lib/camera/RecordingManagement.ts` — `CameraRecordingOptions`:37, `EventTriggerOption`:77, `VideoRecordingOptions`:118, `CameraRecordingConfiguration`:165, `SelectedH264CodecParameters`:201, `parseSelectedConfiguration`:637 (signed read at :660-661), `_supportedVideoRecordingConfiguration`:738
- `src/lib/controller/CameraController.ts` — `CameraControllerOptions`:42, `CameraStreamingDelegate`:150, `CameraRecordingDelegate`:199, class:372
- PR [#1132 "HomeKit Secure Video 3 (iOS 27)"](https://github.com/homebridge/HAP-NodeJS/pull/1132) — draft, 2026-09-15, +5416/−8

**Homebridge 2.4.0** — `src/index.ts` HAP re-exports at :250, :294, :322, :324, :325
**Template** — [homebridge/homebridge-plugin-template](https://github.com/homebridge/homebridge-plugin-template) branch `latest`

**unifi-protect 5.3.1** — `dist/index.d.ts`, `dist/client/client.d.ts`, `dist/devices/camera.d.ts`, `dist/client/livestream-pool.d.ts`, `dist/transport/livestream-session.d.ts`, `dist/types/camera.d.ts`

**homebridge-unifi-protect 8.1.0** — `dist/media/resolution.js` (resolution tables, `buildAdvertisedProfiles`), `dist/media/stream.js:384` (H.264-only gate)

**mp-consulting/homebridge-unifi-protect** — [repo](https://github.com/mp-consulting/homebridge-unifi-protect), commit history through 2026-09-10 (snapshot deadline bounding, zero-dependency migration, optional FFmpeg)

**Matter** — `homebridge/src/matter/types.ts` (curated `deviceTypes` map, `MatterAccessory.deviceType: EndpointType` at :204), `homebridge/src/api.ts:236` (`MatterAPI`); `@matter/types@0.17.9` and `@matter/node@0.17.9` (camera/snapshot-camera/floodlight-camera/video-doorbell device types; CameraAvStreamManagement, WebRtcTransportProvider/Requestor, PushAvStreamTransport, ZoneManagement clusters). On Apple's non-support of Matter cameras: [MacObserver, "4K HomeKit Secure Video in iOS 27"](https://www.macobserver.com/tips/round-ups/4k-homekit-secure-video-ios-27-what-apple-confirmed/), [HomeKit News, June 2026](https://homekitnews.com/2026/06/09/apple-intelligence-and-4k-recording-come-to-the-home-app/)

## 10. The live video investigation (2026-09-18)

Phase 2 produced a stream HomeKit would play but not one anybody would want to watch:
the picture broke up on movement and stalled intermittently. Four defects were behind
it. Three were found by measurement; the fourth was found only by comparing against a
sender known to work, after eight theories had been proposed and killed.

Recorded here because the *method* generalises and the dead ends were expensive.

### 10.1 What was actually wrong

| Defect | Mechanism | Fix |
| --- | --- | --- |
| Oversized datagrams | The negotiated MTU describes the IP datagram; we spent it on the RTP header and auth tag alone, so a 1378 MTU produced 1406-byte datagrams | `maxPayloadSize` subtracts IP+UDP (`88918ef`) |
| Clock drift | The RTP clock was rebuilt from per-segment spacing, re-estimating the frame interval every fragment; it ran 0.92% slow and accumulated without bound (−463 ms over 289 segments) | Anchor each fragment to `tfdt` (`4732438`) |
| Pauses | Protect delivers ~3 pictures per 100 ms fragment and we forwarded them on arrival: a burst, then idle. Send skew 46.5 ms mean against a 33 ms frame interval | Pace on the media clock (`d6ef91d`) |
| Residual artifacting | Fewer per-frame timestamps arrive than the fragment holds pictures in **98%** of fragments, so spacing was synthesised uniformly. Real intervals vary (2999, 3049, 2951, 3000). The error accumulates until it overshoots the next fragment's anchor and **the clock steps backwards** | Space by the `trun`'s own durations (`dc01460`) |

Measured end to end: interarrival jitter 704 ms → 16 ms, send skew 46.5 ms → 1.1 ms,
packet loss zero throughout, backward timestamp steps 6 → 0.

### 10.2 The eight theories that were wrong

Each was plausible, each was killed by measurement, and each cost a test cycle:
B-frames (no composition offsets present) · channel bitrate (capping it made the
picture worse — encoder starvation) · burst overrun (receiver reports put loss at
exactly zero) · Wi-Fi (a wired client was identical) · multi-slice (32,487 pictures,
every one single-slice) · send timing (driven to 1.1 ms skew, symptom unchanged) ·
bandwidth (pinned to a channel inside HomeKit's negotiated budget, symptom unchanged) ·
microbursts (FFmpeg bursts an 81-packet keyframe in 2.9 ms; we do it in 1.8 ms).

### 10.3 What finally worked

Delivering the same stream through FFmpeg's RTP muxer (`-codec:v copy`, so a
byte-identical bitstream) produced a clean picture where ours did not. That reduced an
open-ended question to a diff between two senders on identical input.

SRTP encrypts the payload and leaves the RTP header in the clear, so `tcpdump` on both
paths gives sequence numbers, timestamps and marker bits without any key. Everything
matched — packets per picture (2.25 vs 2.08), intra-picture gap (0.119 vs 0.122 ms),
packet sizes, marker placement, sequence continuity — except one column:

```
ours   : 6 backward timestamp steps in 29 s   (−33 to −67 ticks)
ffmpeg : 0
```

Under a millisecond each, but a backward RTP timestamp is a discontinuity to a
receiver, and at one per ~5 s against a ~3 s keyframe interval the picture is broken
much of the time.

### 10.4 Lessons that cost the most

**A diagnostic that lies is worse than none.** Three shipped this session and each was
briefly believed: a send-skew metric wrecked by 32-bit RTP timestamp wraparound
(reporting a 13-hour mean), a session summary naming the channel the *selector* chose
rather than the one streamed, and a summary of our own sender printed for sessions
FFmpeg delivered. All three were caught only by noticing an internal contradiction.

**Two harness results were announced as conclusions and were artifacts.** A slice-count
"mismatch" (FFmpeg dropped keyframes from a synthetic capture file — our demux was
exact, matching the `trun`'s own byte accounting to 833×4 bytes of length prefix) and
the microburst theory. Both looked decisive.

**The container knew the answer the whole time.** `tfdt` for the timeline and `trun`
durations for the spacing were present in every fragment from the first session. Two of
the four defects came from inferring what the format already stated.

**Verify the build under test.** Node reads `dist` once at startup, so an instance left
running through a rebuild silently serves old code. This cost three cycles and one
false positive before the dev script printed the build it loaded.

### 10.5 Where this leaves the project

The live path now works on its own RTP stack, passthrough, no FFmpeg. But the reason
this plugin exists — OS 27 / HKSV3 / resolutions above 1080p — remains blocked upstream
for *everyone* by HAP-NodeJS (§3, Q5). Until [#1132](https://github.com/homebridge/HAP-NodeJS/pull/1132)
lands, the mature incumbent ([hjdhjd/homebridge-unifi-protect](https://github.com/hjdhjd/homebridge-unifi-protect))
is the better choice for daily use: it already does passthrough (`-codec:v copy`), and
adds HKSV, a timeshift buffer, doorbells, chimes and liveviews.

This remains the research track, and it is now positioned for the moment #1132 lands.
