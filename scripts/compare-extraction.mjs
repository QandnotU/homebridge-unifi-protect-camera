#!/usr/bin/env node
// Compare our fMP4 -> Annex-B extraction against FFmpeg's, on identical input.
//
// FFmpeg's delivery of the same camera is visibly clean where ours artifacts, while HomeKit
// reports zero packet loss for ours — so every packet we send arrives intact. That leaves
// the possibility that what we put *into* those packets is already wrong. The packetization
// verifier cannot see this: it checks that what we packetize reassembles, not that what we
// extracted was right.
//
//   PROTECT_DUMP_DIR=/tmp/protect ./scripts/dev-homebridge.sh      # capture a session
//   node scripts/compare-extraction.mjs /tmp/protect/<session>.mp4
//
// Exits non-zero when the two disagree, and says where.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readAvcConfig } from '../dist/media/fmp4/avcc.js'
import { readTrackInfo } from '../dist/media/fmp4/init-segment.js'
import { readVideoTrackId } from '../dist/media/fmp4/moof.js'
import { splitAccessUnits, withParameterSets } from '../dist/media/fmp4/demux.js'
import { videoTrack } from '../dist/media/broker/video-source.js'

const START_CODE = Buffer.from([0, 0, 0, 1])

function nalsOf(annexB) {
  const nals = []
  let index = annexB.indexOf(START_CODE)

  while (index !== -1) {
    const next = annexB.indexOf(START_CODE, index + 4)
    nals.push(annexB.subarray(index + 4, next === -1 ? annexB.length : next))
    index = next
  }

  return nals
}

function describe(nal) {
  const type = nal.length ? (nal[0] & 0x1f) : -1
  const names = { 1: 'P/B', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD' }

  return `${names[type] ?? `type${type}`}(${nal.length})`
}

const input = process.argv[2]

if (!input) {
  console.error('usage: compare-extraction.mjs <captured.mp4>')
  process.exit(2)
}

// FFmpeg's extraction: the reference, since its delivery of this stream is visibly clean.
const reference = join(tmpdir(), 'protect-reference.h264')

execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
  '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', reference])

// Ours: the same path the streaming delegate feeds to the packetizer.
const file = readFileSync(input)
const config = readAvcConfig(file)
const track = readTrackInfo(file)
const videoTrackId = readVideoTrackId(file)

if (!config || !track) {
  console.error('could not read avcC or track info from the capture')
  process.exit(2)
}

console.log(`Track ${videoTrackId} — ${track.width}x${track.height}, timescale ${track.timescale}`)

// Walk top-level boxes, pairing each moof with the segment that follows it, exactly as the
// live path sees them.
const ours = []
let offset = 0
let segments = 0

while ((offset + 8) <= file.length) {
  const size = file.readUInt32BE(offset)
  const type = file.toString('latin1', offset + 4, offset + 8)

  if (size < 8) {
    break
  }

  if (type === 'moof') {
    const end = Math.min(file.length, offset + size + (((offset + size + 8) <= file.length) ? file.readUInt32BE(offset + size) : 0))
    const segment = file.subarray(offset, end)
    const extracted = videoTrack({ data: segment }, videoTrackId)

    if (extracted) {
      segments += 1

      for (const unit of splitAccessUnits(extracted.payload, config)) {
        for (const nal of withParameterSets(unit, config).nals) {
          ours.push(nal)
        }
      }
    }
  }

  offset += size
}

const theirs = nalsOf(readFileSync(reference))

// Our stream injects SPS/PPS at every keyframe; FFmpeg's does too, but a reference may also
// carry AUD or SEI we drop. Compare only the coded slices, which are what actually decode.
const isSlice = nal => [1, 5].includes(nal[0] & 0x1f)
const oursSlices = ours.filter(isSlice)
const theirsSlices = theirs.filter(isSlice)

console.log(`Segments walked : ${segments}`)
console.log(`Slices — ours   : ${oursSlices.length}`)
console.log(`Slices — ffmpeg : ${theirsSlices.length}`)

if (oursSlices.length !== theirsSlices.length) {
  console.error(`\nMISMATCH: slice counts differ by ${Math.abs(oursSlices.length - theirsSlices.length)}.`)
  console.error('Our extraction is producing a different number of pictures than the reference.')
  process.exit(1)
}

let mismatches = 0

for (let index = 0; index < oursSlices.length; index++) {
  if (!oursSlices[index].equals(theirsSlices[index])) {
    if (mismatches < 5) {
      console.error(`\nslice ${index}: ours ${describe(oursSlices[index])} vs ffmpeg ${describe(theirsSlices[index])}`)

      const a = oursSlices[index]
      const b = theirsSlices[index]
      let at = 0

      while ((at < a.length) && (at < b.length) && (a[at] === b[at])) {
        at += 1
      }

      console.error(`  first differing byte at ${at} of ${a.length}/${b.length}`)
    }

    mismatches += 1
  }
}

if (mismatches) {
  console.error(`\nMISMATCH: ${mismatches} of ${oursSlices.length} slices differ.`)
  console.error('The bitstream we transmit is not the one the camera sent.')
  process.exit(1)
}

console.log('\nIdentical: every coded slice matches the reference byte for byte.')
console.log('Extraction is correct, so the fault is in packetization or transport.')
