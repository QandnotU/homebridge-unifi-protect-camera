#!/usr/bin/env bash
# Phase 0 §8.1 — what codecs and channels do the cameras actually offer?
# Prompts for the password (hidden). Never writes it to argv, history or disk.
set -euo pipefail

HOST="${1:-}"
PROTECT_USER="${2:-}"

[ -z "$HOST" ] && read -r -p "Protect controller host/IP: " HOST
[ -z "$PROTECT_USER" ] && read -r -p "Protect username: " PROTECT_USER
read -r -s -p "Protect password (hidden): " PROTECT_PASS
echo

JAR="$(mktemp -t protectjar.XXXXXX)"
BOOT="$(mktemp -t protectboot.XXXXXX)"
cleanup() { rm -f "$JAR" "$BOOT"; }
trap cleanup EXIT

BODY="$(PROTECT_USER="$PROTECT_USER" PROTECT_PASS="$PROTECT_PASS" node -e \
  'process.stdout.write(JSON.stringify({password:process.env.PROTECT_PASS,username:process.env.PROTECT_USER}))')"

echo "→ authenticating to $HOST ..."
CODE="$(curl -sk -c "$JAR" -o /dev/null -w '%{http_code}' --max-time 20 \
  -X POST "https://$HOST/api/auth/login" \
  -H 'Content-Type: application/json' --data-binary "$BODY" || echo 000)"
unset PROTECT_PASS BODY

if [ "$CODE" != "200" ]; then
  echo "✗ login failed (HTTP $CODE)."
  case "$CODE" in
    401|403) echo "  Check the username/password, and that this is a LOCAL Protect user, not a Ubiquiti cloud account." ;;
    499)     echo "  The account requires 2FA. Create a dedicated local user without 2FA for the plugin." ;;
    000)     echo "  Could not reach $HOST. Check the address and that you are on the same network." ;;
  esac
  exit 1
fi

echo "→ fetching bootstrap ..."
curl -sk -b "$JAR" --max-time 30 "https://$HOST/proxy/protect/api/bootstrap" -o "$BOOT"

node -e '
const fs = require("fs")
let b
try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) }
catch { console.error("✗ bootstrap was not JSON — is this a UniFi Protect controller?"); process.exit(1) }

const nvr = b.nvr ?? {}
console.log("\n" + "=".repeat(64))
console.log(`Controller : ${nvr.name ?? "?"}  (${nvr.type ?? "?"})`)
console.log(`Protect    : ${nvr.version ?? "?"}`)
console.log("=".repeat(64))

const cameras = b.cameras ?? []
if (!cameras.length) { console.log("\nNo cameras visible to this account."); process.exit(0) }

const mbps = n => (typeof n === "number" ? (n / 1e6).toFixed(1) + " Mbps" : "?")

for (const c of cameras) {
  const supports = c.featureFlags?.videoCodecs ?? []
  console.log(`\n${c.name ?? "(unnamed)"} — ${c.type ?? "?"}`)
  console.log(`  active codec   : ${c.videoCodec ?? "?"}`)
  console.log(`  supports       : ${supports.length ? supports.join(", ") : "(not reported)"}`)
  console.log(`  HEVC capable   : ${supports.includes("h265") ? "YES" : "no"}`)

  const channels = c.channels ?? []
  console.log("  channels:")
  for (const ch of channels) {
    const dims = `${ch.width}x${ch.height}`.padEnd(11)
    console.log(`    ${String(ch.name ?? "?").padEnd(16)} ${dims} @ ${String(ch.fps ?? "?").padStart(2)}fps  up to ${mbps(ch.bitrate).padStart(9)}` +
      `  rtsp:${ch.isRtspEnabled ? "on " : "off"}  ${ch.enabled === false ? "(disabled)" : ""}`)
  }

  for (const ch of channels) {
    const opts = ch.fpsValues ?? []
    if (opts.length) { console.log(`    fps for ${ch.name}: ${opts.join(", ")}`) }
  }
  console.log(`  has 2560x1440  : ${channels.some(ch => ch.width === 2560 && ch.height === 1440) ? "yes" : "no"}`)
  const ff = c.featureFlags ?? {}
  console.log(`  audio          : mic ${c.hasMic ? "yes" : "no"}, speaker ${c.hasSpeaker ? "yes" : "no"}, codecs ${(ff.audioCodecs ?? []).join(", ") || "?"}`)
  console.log(`  smart detect   : ${(ff.smartDetectTypes ?? []).join(", ") || "(none)"}`)
  console.log(`  firmware       : ${c.firmwareVersion ?? "?"}`)
}
console.log("\n" + "=".repeat(64))
' "$BOOT"
