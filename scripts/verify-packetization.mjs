// Take a captured Annex-B stream, run it through the real packetizer and SRTP, then
// reassemble it the way a receiver does and compare against the input.
//
// Any difference is a bug in our sending path, found without a packet capture.
//
//   node scripts/verify-packetization.mjs /tmp/protect/<session>.h264

import { readFileSync } from 'node:fs'

import { H264Packetizer, RTP_HEADER_SIZE, maxPayloadSize } from '../dist/media/rtp/h264-packetizer.js'
import { SrtpSession } from '../dist/media/rtp/srtp.js'

const file = process.argv[2]

if (!file) {
  console.error('usage: node scripts/verify-packetization.mjs <file.h264>')
  process.exit(1)
}

const stream = readFileSync(file)

/** Split an Annex-B stream back into NAL units. */
function annexBNals(buffer) {
  const nals = []
  const starts = []

  for (let i = 0; i + 3 < buffer.length; i++) {
    if ((buffer[i] === 0) && (buffer[i + 1] === 0) && (buffer[i + 2] === 0) && (buffer[i + 3] === 1)) {
      starts.push(i + 4)
      i += 3
    }
  }

  for (let i = 0; i < starts.length; i++) {
    const end = (i + 1 < starts.length) ? (starts[i + 1] - 4) : buffer.length
    nals.push(buffer.subarray(starts[i], end))
  }

  return nals
}

/** Reassemble NAL units from RTP packets, per RFC 6184. */
function reassemble(packets) {
  const nals = []
  let pending = null

  for (const packet of packets) {
    const payload = packet.subarray(RTP_HEADER_SIZE)
    const type = payload[0] & 0x1f

    if (type !== 28) {
      nals.push(Buffer.from(payload))
      continue
    }

    const fuHeader = payload[1]
    const start = (fuHeader & 0x80) !== 0
    const end = (fuHeader & 0x40) !== 0
    const originalHeader = (payload[0] & 0xe0) | (fuHeader & 0x1f)

    if (start) {
      pending = [Buffer.from([originalHeader])]
    }

    if (!pending) {
      console.error('  fragment arrived with no start marker')
      continue
    }

    pending.push(Buffer.from(payload.subarray(2)))

    if (end) {
      nals.push(Buffer.concat(pending))
      pending = null
    }
  }

  return nals
}

const original = annexBNals(stream)
const fragmented = original.filter(n => n.length > maxPayloadSize(1378))

console.log(`NAL units      : ${original.length} (${fragmented.length} need fragmenting at MTU 1378)`)
console.log(`largest NAL    : ${Math.max(...original.map(n => n.length))} bytes`)

const packetizer = new H264Packetizer({ maxPayloadSize: maxPayloadSize(1378), payloadType: 99, ssrc: 0x11223344 })
const packets = []

// One access unit per NAL is enough to exercise fragmentation and reassembly.
for (const [index, nal] of original.entries()) {
  packets.push(...packetizer.packetizeAccessUnit([nal], index * 3000))
}

console.log(`RTP packets    : ${packets.length}`)
console.log(`oversized      : ${packets.filter(p => p.length > 1368).length}`)

const recovered = reassemble(packets)

console.log(`recovered NALs : ${recovered.length}`)

let mismatches = 0

for (let i = 0; i < Math.max(original.length, recovered.length); i++) {
  const a = original[i]
  const b = recovered[i]

  if (!a || !b || !a.equals(b)) {
    if (mismatches < 5) {
      console.log(`  MISMATCH at ${i}: original ${a?.length ?? 'missing'} bytes, recovered ${b?.length ?? 'missing'} bytes`)
    }

    mismatches += 1
  }
}

console.log(mismatches === 0 ? '\n✓ packetization round-trips byte for byte' : `\n✗ ${mismatches} NAL units differ`)

// Now the same, through SRTP.
const key = Buffer.alloc(16, 7)
const salt = Buffer.alloc(14, 9)
const srtp = new SrtpSession(key, salt, 0x11223344)
const protectedPackets = packets.map(p => srtp.protect(p))
const overMtu = protectedPackets.filter(p => p.length > 1378).length

console.log(`\nSRTP packets   : ${protectedPackets.length}`)
console.log(`over MTU 1378  : ${overMtu}`)
console.log(`largest packet : ${Math.max(...protectedPackets.map(p => p.length))} bytes`)
