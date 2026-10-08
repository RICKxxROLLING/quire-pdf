// Rasterizes the Quire app icon (1024x1024 PNG) without any native deps.
import { writeFileSync, mkdirSync } from 'fs'
import { deflateSync } from 'zlib'

const S = 1024
const px = new Float32Array(S * S * 4)

const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
}
const cov = (d) => Math.min(1, Math.max(0, 0.5 - d))
const blend = (i, r, g, b, a) => {
  const o = px[i + 3], na = a + o * (1 - a)
  if (na <= 0) return
  px[i] = (r * a + px[i] * o * (1 - a)) / na
  px[i + 1] = (g * a + px[i + 1] * o * (1 - a)) / na
  px[i + 2] = (b * a + px[i + 2] * o * (1 - a)) / na
  px[i + 3] = na
}
const lerp = (a, b, t) => a + (b - a) * t

for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const i = (y * S + x) * 4
  // background squircle with violet→indigo gradient
  const bg = cov(sdRoundRect(x, y, 512, 512, 432, 432, 190))
  if (bg > 0) {
    const t = (x + y) / (2 * S)
    blend(i, lerp(139, 79, t), lerp(92, 70, t), lerp(246, 229, t), bg)
  }
  // soft shadow under the page
  const sh = sdRoundRect(x, y, 530, 545, 230, 290, 40)
  if (sh < 40) blend(i, 30, 20, 80, 0.18 * Math.min(1, (40 - sh) / 40) * bg)
  // page with folded corner
  const page = sdRoundRect(x, y, 512, 520, 230, 290, 36)
  const fold = (x - 742) - (y - 230) + 150 // cut the top-right corner diagonally
  const pageCov = cov(Math.max(page, fold / Math.SQRT2))
  if (pageCov > 0) blend(i, 255, 255, 255, pageCov)
  const flap = Math.max(fold / Math.SQRT2, sdRoundRect(x, y, 592 + 75, 230 + 75, 75, 75, 18))
  if (flap < 1) blend(i, 199, 190, 250, cov(flap))
  // text lines
  for (const [ly, lw] of [[420, 300], [500, 340], [580, 340], [660, 220]]) {
    const d = sdRoundRect(x, y, 342 + lw / 2, ly, lw / 2, 18, 18)
    if (d < 1) blend(i, 214, 210, 240, cov(d))
  }
  // highlighter swipe
  const hl = sdRoundRect(x, y, 470, 580, 160, 30, 12)
  if (hl < 1) blend(i, 250, 204, 21, 0.85 * cov(hl))
}

const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  for (let x = 0; x < S * 4; x++) raw[y * (S * 4 + 1) + 1 + x] = Math.round(Math.min(1, px[y * S * 4 + x] / (x % 4 === 3 ? 1 : 255)) * 255)
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
mkdirSync('src/renderer/public', { recursive: true })
writeFileSync('src/renderer/public/icon.png', png)
console.log('icon written')
