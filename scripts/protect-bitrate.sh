#!/usr/bin/env bash
# Show, and optionally change, per-channel bitrate and frame rate on a Protect camera.
#
# Read-only unless --set is given, and a --set still requires typed confirmation showing
# exactly what will change. Prompts for the password; never places it in argv, shell
# history or on disk.
#
#   show: bash scripts/protect-bitrate.sh 10.69.1.1
#   set:  bash scripts/protect-bitrate.sh 10.69.1.1 --camera Office --channel Medium --set 500000
#   fps:  bash scripts/protect-bitrate.sh 10.69.1.1 --camera Office --channel High --fps 30
#
# HomeKit negotiates only 15, 24 or 30 fps. A channel set to anything else cannot be
# advertised honestly, which is what made the High channel at 20 fps unusable.
set -euo pipefail

HOST="${1:-}"
[ $# -gt 0 ] && shift

CAMERA=""
CHANNEL=""
TARGET=""
FPS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --camera) CAMERA="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --set) TARGET="${2:-}"; shift 2 ;;
    --fps) FPS="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1"; exit 1 ;;
  esac
done

[ -z "$HOST" ] && read -r -p "Protect controller host/IP: " HOST
read -r -p "Protect username: " PROTECT_USER
read -r -s -p "Protect password (hidden): " PROTECT_PASS
echo

JAR="$(mktemp -t protectjar.XXXXXX)"
BOOT="$(mktemp -t protectboot.XXXXXX)"
PLAN="$(mktemp -t protectplan.XXXXXX)"
HDRS="$(mktemp -t protecthdr.XXXXXX)"
trap 'rm -f "$JAR" "$BOOT" "$PLAN" "$HDRS"' EXIT

BODY="$(PROTECT_USER="$PROTECT_USER" PROTECT_PASS="$PROTECT_PASS" node -e \
  'process.stdout.write(JSON.stringify({password:process.env.PROTECT_PASS,username:process.env.PROTECT_USER}))')"

CODE="$(curl -sk -c "$JAR" -D "$HDRS" -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST "https://$HOST/api/auth/login" -H 'Content-Type: application/json' --data-binary "$BODY" || echo 000)"
unset PROTECT_PASS BODY

if [ "$CODE" != "200" ]; then
  echo "✗ login failed (HTTP $CODE)."
  case "$CODE" in
    401) echo "  Wrong username or password." ;;
    403) echo "  Rejected. Check this is a LOCAL Protect user rather than a Ubiquiti cloud account," ;
         echo "  and note UniFi OS locks an account briefly after a failed attempt - wait a minute and retry." ;;
    499) echo "  The account requires 2FA. Use a dedicated local user without it." ;;
    000) echo "  Could not reach $HOST. Check the address and that you are on the same network." ;;
  esac
  exit 1
fi

# UniFi OS requires the CSRF token from the login response on any write.
CSRF="$(awk 'tolower($1) == "x-csrf-token:" { gsub(/\r/, "", $2); print $2 }' "$HDRS" | tail -1)"

curl -sk -b "$JAR" --max-time 30 "https://$HOST/proxy/protect/api/bootstrap" -o "$BOOT"

node -e '
const fs = require("fs")
const [bootPath, planPath, wantCamera, wantChannel, target, wantFps] = process.argv.slice(1)
const bootstrap = JSON.parse(fs.readFileSync(bootPath, "utf8"))
const rate = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + " Mbps" : Math.round(n / 1e3) + " Kbps")

for (const camera of bootstrap.cameras ?? []) {
  if (wantCamera && (camera.name !== wantCamera)) { continue }

  console.log(`\n${camera.name}`)

  for (const channel of camera.channels ?? []) {
    const mark = (wantChannel && (channel.name === wantChannel)) ? "  <-" : ""

    const auto = [channel.autoBitrate ? "autoBitrate" : "", channel.autoFps ? "autoFps" : ""].filter(Boolean).join(" ")

    console.log(`  ${String(channel.name).padEnd(16)} ${channel.width}x${channel.height}@${channel.fps}fps` +
      `   current ${rate(channel.bitrate).padStart(9)}` +
      `   allowed ${rate(channel.minBitrate)} .. ${rate(channel.maxBitrate)}${mark}`)
    console.log(`  ${" ".repeat(16)} fps offered: ${(channel.fpsValues ?? []).join(", ") || "(none reported)"}`)

    if (auto) { console.log(`  ${" ".repeat(16)} automatic: ${auto} - an explicit setting may be overridden`) }
  }
}

if (!target && !wantFps) {
  console.log("\nRead-only. To change one:")
  console.log("  --camera <name> --channel <name> --set <bits per second>")
  console.log("  --camera <name> --channel <name> --fps <frames per second>")
  process.exit(3)
}

const camera = (bootstrap.cameras ?? []).find(c => c.name === wantCamera)

if (!camera) { console.error(`\n✗ no camera named ${JSON.stringify(wantCamera)}`); process.exit(1) }

const channel = (camera.channels ?? []).find(c => c.name === wantChannel)

if (!channel) { console.error(`\n✗ no channel named ${JSON.stringify(wantChannel)}`); process.exit(1) }

const fpsValue = wantFps ? Number(wantFps) : null

if (fpsValue !== null) {
  const offered = channel.fpsValues ?? []

  if (!offered.includes(fpsValue)) {
    console.error(`\nx ${wantFps} fps is not offered on this channel. Offered: ${offered.join(", ")}`)
    process.exit(1)
  }

  if (![15, 24, 30].includes(fpsValue)) {
    console.error(`\nx HomeKit negotiates 15, 24 or 30 fps only; ${fpsValue} cannot be advertised honestly.`)
    process.exit(1)
  }
}

const value = target ? Number(target) : null

if ((value !== null) && (!Number.isFinite(value) || (value < channel.minBitrate) || (value > channel.maxBitrate))) {
  console.error(`\n✗ ${target} is outside this channel'"'"'s allowed range ` +
    `${channel.minBitrate}..${channel.maxBitrate}`)
  process.exit(1)
}

const changes = []

if (value !== null) { changes.push(`bitrate ${rate(channel.bitrate)} -> ${rate(value)}`) }
if (fpsValue !== null) { changes.push(`fps ${channel.fps} -> ${fpsValue}`) }

console.log(`\nChange: ${camera.name} / ${channel.name}   ${changes.join(",  ")}`)

if ((fpsValue !== null) && channel.autoFps) { console.log("  also clearing autoFps, which would otherwise override it") }
if ((value !== null) && channel.autoBitrate) { console.log("  also clearing autoBitrate, which would otherwise override it") }
console.log("This writes to your Protect controller and affects every consumer of that channel.")

fs.writeFileSync(planPath, JSON.stringify({
  body: { channels: camera.channels.map(c => {
    if (c.id !== channel.id) { return c }

    const next = { ...c }

    // Protect re-derives an automatic setting and would undo an explicit one, so the
    // matching flag is cleared whenever a value is set by hand.
    if (value !== null) { next.bitrate = value; next.autoBitrate = false }
    if (fpsValue !== null) { next.fps = fpsValue; next.autoFps = false }

    return next
  }) },
  cameraId: camera.id,
}))
' "$BOOT" "$PLAN" "$CAMERA" "$CHANNEL" "$TARGET" "$FPS" && APPLY=1 || APPLY=0

[ "$APPLY" = "1" ] || exit 0

read -r -p $'\nType yes to apply: ' CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "Cancelled. Nothing was changed."; exit 0; }

CAMERA_ID="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).cameraId)' "$PLAN")"
node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).body))' "$PLAN" > "$PLAN.body"

RESULT="$(curl -sk -b "$JAR" -o /dev/null -w '%{http_code}' --max-time 20 \
  -X PATCH "https://$HOST/proxy/protect/api/cameras/$CAMERA_ID" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  --data-binary @"$PLAN.body")"

rm -f "$PLAN.body"

if [ "$RESULT" = "200" ]; then
  echo "✓ Applied. Re-run without --set to confirm."
else
  echo "✗ Protect rejected the change (HTTP $RESULT)."
  exit 1
fi
