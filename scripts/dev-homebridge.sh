#!/usr/bin/env bash
# Run this plugin in an isolated Homebridge instance for live testing.
#
# Uses its own storage directory, bridge identity, PIN and port, so it never touches or
# conflicts with a real Homebridge install. Prompts for the Protect password on first run
# and writes it to config.json with 0600 permissions — the config lives outside the repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="${HOMEBRIDGE_DEV_DIR:-$HOME/.homebridge-dev}"
CONFIG="$DEV_DIR/config.json"

# Homebridge 2.x needs Node 22, 24 or 26, and the plugin's `undici` dependency crashes
# outright on Node 20. A plain `bash script.sh` does not honour .nvmrc, so resolve a
# supported Node ourselves rather than trusting whatever is on PATH — running under the
# wrong one loads no plugin, and Homebridge then treats every cached accessory as an
# orphan and unregisters it.
find_node() {
  local candidate major
  for candidate in "$(command -v node || true)" "$HOME"/.nvm/versions/node/v*/bin/node; do
    [ -x "$candidate" ] || continue
    major="$("$candidate" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
    case "$major" in
      22|24|26) echo "$candidate"; return 0 ;;
    esac
  done
  return 1
}

NODE_BIN="$(find_node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "✗ No Node 22, 24 or 26 found. Homebridge 2.x will not run on $(node --version 2>/dev/null || echo 'the current Node')."
  echo "  Install one, e.g.:  nvm install 24"
  exit 1
fi

export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "Node       : $("$NODE_BIN" --version) ($NODE_BIN)"

mkdir -p "$DEV_DIR"

if [ ! -f "$CONFIG" ]; then
  echo "No config at $CONFIG — creating one."
  echo

  read -r -p "Protect controller host/IP: " HOST
  read -r -p "Protect username (a dedicated LOCAL user): " PROTECT_USER
  read -r -s -p "Protect password (hidden): " PROTECT_PASS
  echo

  # Random locally-administered bridge MAC and PIN, so this instance can never collide
  # with a real one on the network.
  PRIMARY_IFACE="$(route -n get default 2>/dev/null | awk '"'"'/interface:/{print $2}'"'"')" \
    HOST="$HOST" PROTECT_USER="$PROTECT_USER" PROTECT_PASS="$PROTECT_PASS" node -e '
    const { randomInt } = require("node:crypto")
    const fs = require("node:fs")
    const hex = () => randomInt(0, 256).toString(16).padStart(2, "0").toUpperCase()
    const pin = `${String(randomInt(100, 1000))}-${String(randomInt(10, 100))}-${String(randomInt(100, 1000))}`
    const config = {
      bridge: {
        name: "Protect Dev Bridge",
        username: ["0E", hex(), hex(), hex(), hex(), hex()].join(":"),
        pin,
        port: 51888,
        // Pin the HAP advertisement to the interface that actually reaches the LAN. With a
        // VPN tunnel or a self-assigned 169.254 Ethernet present, the advertiser can pick
        // those instead, and the Home app then hangs on "Connecting..." before giving up
        // with "accessory not found".
        bind: [process.env.PRIMARY_IFACE].filter(Boolean),
      },
      platforms: [{
        platform: "UniFiProtectCamera",
        name: "UniFi Protect Camera",
        controllers: [{
          name: "Dev NVR",
          host: process.env.HOST,
          username: process.env.PROTECT_USER,
          password: process.env.PROTECT_PASS,
          verifyTls: false,
        }],
        options: { maximumQuality: false, verboseDiagnostics: true },
      }],
    }
    fs.writeFileSync(process.argv[1], JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
    console.log(`\nWrote ${process.argv[1]} (pairing PIN ${pin})`)
  ' "$CONFIG"
  unset PROTECT_PASS

  chmod 600 "$CONFIG"
  echo
fi

echo "Building ..."
npm --prefix "$HERE" run build >/dev/null

# A Ctrl-C in the terminal does not always take the Homebridge child with it, and the
# orphan keeps the HAP port. Without this the next run dies on EADDRINUSE with a stack
# trace that says nothing about the cause.
# Keep bridge.bind on whatever interface currently reaches the LAN. Pinning it once at
# config creation means a cable swap silently leaves HAP advertising on the old interface,
# and the Home app then cannot reach the bridge at all.
PRIMARY_IFACE="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"

if [ -n "$PRIMARY_IFACE" ]; then
  PRIMARY_IFACE="$PRIMARY_IFACE" node -e '
    const fs = require("fs")
    const path = process.argv[1]
    const config = JSON.parse(fs.readFileSync(path, "utf8"))
    const want = process.env.PRIMARY_IFACE
    const have = (config.bridge.bind ?? [])[0]

    if (have !== want) {
      config.bridge.bind = [want]
      fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
      console.log(`Bind       : ${want} (was ${have ?? "unset"})`)
    } else {
      console.log(`Bind       : ${want}`)
    }
  ' "$CONFIG"
fi

PORT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).bridge.port)' "$CONFIG")"
STALE="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"

if [ -n "$STALE" ]; then
  echo "✗ Port $PORT is already held by PID $STALE — most likely a previous run of this"
  echo "  script whose process outlived its terminal."
  echo
  ps -o pid,etime,command -p "$STALE" 2>/dev/null | cat
  echo
  read -r -p "Stop it and continue? [y/N] " REPLY

  case "$REPLY" in
    [yY]*)
      kill "$STALE" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 || break
        sleep 0.5
      done
      ;;
    *) echo "Leaving it alone. Nothing started."; exit 1 ;;
  esac
fi

echo "Pairing PIN: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).bridge.pin)' "$CONFIG")"
echo "Storage    : $DEV_DIR"
echo "Ctrl-C to stop."
echo

# -K keeps cached accessories when the plugin fails to load. Without it a build error or a
# wrong Node version unregisters every paired camera, losing its room and automations.
exec "$NODE_BIN" "$HERE/node_modules/homebridge/bin/homebridge.js" -D -K -U "$DEV_DIR" -P "$HERE" --strict-plugin-resolution
