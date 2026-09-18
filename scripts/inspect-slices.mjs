// How many slices does each picture use, and can we read first_mb_in_slice?
//
//   node scripts/inspect-slices.mjs /tmp/protect/<session>.h264
import { readFileSync } from 'node:fs'
import { firstMacroblockInSlice, nalType } from '../dist/media/fmp4/avcc.js'

const buf = readFileSync(process.argv[2])
const starts = []

for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) { starts.push(i + 4); i += 3 }
}

const nals = starts.map((s, i) => buf.subarray(s, (i + 1 < starts.length) ? starts[i + 1] - 4 : buf.length))
const vcl = nals.filter(n => { const t = nalType(n); return (t >= 1) && (t <= 5) })

let pictures = 0
let slices = 0
const histogram = {}
const values = {}
let unreadable = 0

for (const nal of vcl) {
  const firstMb = firstMacroblockInSlice(nal)

  if (firstMb === null) { unreadable += 1 }

  const key = String(firstMb)
  values[key] = (values[key] ?? 0) + 1

  if (firstMb === 0) {
    if (slices > 0) { histogram[slices] = (histogram[slices] ?? 0) + 1; pictures += 1 }
    slices = 1
  } else {
    slices += 1
  }
}

if (slices > 0) { histogram[slices] = (histogram[slices] ?? 0) + 1; pictures += 1 }

console.log('VCL NALs        :', vcl.length)
console.log('pictures        :', pictures)
console.log('slices/picture  :', JSON.stringify(histogram))
console.log('unreadable hdrs :', unreadable)
console.log('first_mb values :', JSON.stringify(Object.fromEntries(
  Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, 8))))
