#!/usr/bin/env node
// Compare how two senders put the same video on the wire.
//
// SRTP encrypts the payload and leaves the RTP header in the clear, so sequence number,
// timestamp and marker bit are readable from a capture without any key. Pairing those with
// the capture's own arrival times shows exactly how each sender spaces its packets — which
// is the one difference between our path and FFmpeg's that no sender-side instrument can
// see, and the last place the artifacting can be hiding.
//
//   sudo tcpdump -i en0 -w /tmp/ours.pcap 'udp and host <phone>'
//   node scripts/analyze-pcap.mjs /tmp/ours.pcap [/tmp/ffmpeg.pcap]

import { readFileSync } from 'node:fs'

const LINK_HEADER = { 0: 4, 1: 14, 12: 4, 101: 0, 113: 16 }

function readPcap(path) {
  const file = readFileSync(path)
  const magic = file.readUInt32LE(0)
  const swapped = (magic === 0xd4c3b2a1) || (magic === 0x4d3cb2a1)
  const nanos = (magic === 0xa1b23c4d) || (magic === 0x4d3cb2a1)

  if (![0xa1b2c3d4, 0xd4c3b2a1, 0xa1b23c4d, 0x4d3cb2a1].includes(magic)) {
    throw new Error(`not a pcap file (magic ${magic.toString(16)}) — pcapng is not supported, use tcpdump not Wireshark`)
  }

  const u32 = offset => (swapped ? file.readUInt32BE(offset) : file.readUInt32LE(offset))
  const linkType = u32(20)
  const linkBytes = LINK_HEADER[linkType]

  if (linkBytes === undefined) {
    throw new Error(`unsupported link type ${linkType}`)
  }

  const packets = []
  let offset = 24

  while ((offset + 16) <= file.length) {
    const seconds = u32(offset)
    const fraction = u32(offset + 4)
    const included = u32(offset + 8)
    const at = seconds + (fraction / (nanos ? 1e9 : 1e6))
    const frame = file.subarray(offset + 16, offset + 16 + included)

    offset += 16 + included

    // Ethernet/loopback header, then IPv4, then UDP.
    let cursor = linkBytes

    if ((cursor + 20) > frame.length) {
      continue
    }

    const version = frame[cursor] >> 4

    if (version !== 4) {
      continue
    }

    const ihl = (frame[cursor] & 0x0f) * 4
    const protocol = frame[cursor + 9]

    cursor += ihl

    if ((protocol !== 17) || ((cursor + 8) > frame.length)) {
      continue
    }

    const payload = frame.subarray(cursor + 8)

    // An RTP header: version 2, and a payload type that is not an RTCP one.
    if ((payload.length < 12) || ((payload[0] >> 6) !== 2)) {
      continue
    }

    const payloadType = payload[1] & 0x7f

    if ((payloadType >= 72) && (payloadType <= 76)) {
      continue
    }

    packets.push({
      at,
      marker: (payload[1] & 0x80) !== 0,
      sequence: payload.readUInt16BE(2),
      size: payload.length,
      ssrc: payload.readUInt32BE(8),
      timestamp: payload.readUInt32BE(4),
    })
  }

  return packets
}

function analyse(label, packets) {
  if (!packets.length) {
    console.log(`\n${label}: no RTP packets found`)

    return
  }

  // Keep the busiest SSRC: the video stream.
  const counts = new Map()

  for (const packet of packets) {
    counts.set(packet.ssrc, (counts.get(packet.ssrc) ?? 0) + 1)
  }

  const ssrc = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  const stream = packets.filter(packet => packet.ssrc === ssrc)

  // Group into pictures by RTP timestamp.
  const frames = []
  let current = null

  for (const packet of stream) {
    if (!current || (packet.timestamp !== current.timestamp)) {
      current = { first: packet.at, last: packet.at, packets: 0, timestamp: packet.timestamp }
      frames.push(current)
    }

    current.packets += 1
    current.last = packet.at
  }

  // Gaps between packets inside one picture: the microburst measurement.
  const within = []

  for (let index = 1; index < stream.length; index++) {
    if (stream[index].timestamp === stream[index - 1].timestamp) {
      within.push((stream[index].at - stream[index - 1].at) * 1000)
    }
  }

  const sorted = [...within].sort((a, b) => a - b)
  const at = q => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0)
  const big = frames.filter(frame => frame.packets >= 10)
  const span = frame => (frame.last - frame.first) * 1000

  console.log(`\n${label}`)
  console.log(`  ssrc 0x${ssrc.toString(16)} — ${stream.length} packets, ${frames.length} pictures`)
  console.log(`  duration            : ${(stream.at(-1).at - stream[0].at).toFixed(1)} s`)
  console.log(`  packets per picture : mean ${(stream.length / frames.length).toFixed(2)}, max ${Math.max(...frames.map(f => f.packets))}`)
  console.log(`  gap within picture  : median ${at(0.5).toFixed(3)} ms, p90 ${at(0.9).toFixed(3)} ms, max ${at(1).toFixed(2)} ms`)

  if (big.length) {
    const spans = big.map(span)

    console.log(`  pictures >= 10 pkts : ${big.length}, spread over mean ${(spans.reduce((t, v) => t + v, 0) / big.length).toFixed(1)} ms, max ${Math.max(...spans).toFixed(1)} ms`)
    console.log(`                        (largest is ${Math.max(...big.map(f => f.packets))} packets)`)
  } else {
    console.log('  pictures >= 10 pkts : none in this capture')
  }

  const lost = stream.reduce((total, packet, index) =>
    (index && (((packet.sequence - stream[index - 1].sequence) & 0xffff) !== 1) ? total + 1 : total), 0)

  console.log(`  sequence breaks     : ${lost}`)
}

const files = process.argv.slice(2)

if (!files.length) {
  console.error('usage: analyze-pcap.mjs <ours.pcap> [ffmpeg.pcap]')
  process.exit(2)
}

for (const file of files) {
  try {
    analyse(file, readPcap(file))
  } catch (error) {
    console.error(`${file}: ${error.message}`)
  }
}

console.log('\nA sender that spreads a large picture across its frame interval shows a')
console.log('median gap near 1 ms and a wide spread; one that bursts shows a gap near zero.')
