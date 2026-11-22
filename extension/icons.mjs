// 生成 16/48/128 三个真实 PNG 图标（无第三方依赖）。
// 规范要求：每个尺寸都是独立文件、像素尺寸正确，不能复用同一张图。
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'icons')

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const BRAND = [77, 107, 254]
const WHITE = [255, 255, 255]
const MASTER = 512

// 圆角矩形的有符号距离，用来做抗锯齿
function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius))
  const cy = Math.max(top + radius, Math.min(y, bottom - radius))
  const dx = x - cx
  const dy = y - cy
  return Math.hypot(dx, dy) - radius
}

// 凸三角形的有符号距离：三条边的半平面距离取最大
function triangleDistance(px, py, a, b, c) {
  const edges = [
    [a, b],
    [b, c],
    [c, a],
  ]
  let distance = -Infinity
  for (const [p, q] of edges) {
    const ex = q[0] - p[0]
    const ey = q[1] - p[1]
    const length = Math.hypot(ex, ey)
    const normalX = ey / length
    const normalY = -ex / length
    const centroidX = (a[0] + b[0] + c[0]) / 3
    const centroidY = (a[1] + b[1] + c[1]) / 3
    const sign = (centroidX - p[0]) * normalX + (centroidY - p[1]) * normalY >= 0 ? 1 : -1
    distance = Math.max(distance, ((px - p[0]) * normalX + (py - p[1]) * normalY) * sign)
  }
  return distance
}

const DOTS = [
  [188, 240],
  [256, 240],
  [324, 240],
]

function render(size) {
  const scale = size / MASTER
  const edge = 1.5 / scale
  const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance / edge))
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / scale
      const py = (y + 0.5) / scale
      const bg = coverage(roundedRectDistance(px, py, 28, 28, MASTER - 28, MASTER - 28, 116))
      const bubble = coverage(roundedRectDistance(px, py, 116, 148, 396, 348, 66))
      // 气泡里的三个蓝点：在白色区域内再挖出品牌色
      let dot = 0
      for (const [cx, cy] of DOTS) {
        dot = Math.max(dot, coverage(Math.hypot(px - cx, py - cy) - 22))
      }
      const white = bubble * (1 - dot)
      const i = (y * size + x) * 4
      rgba[i] = Math.round(BRAND[0] * (1 - white) + WHITE[0] * white)
      rgba[i + 1] = Math.round(BRAND[1] * (1 - white) + WHITE[1] * white)
      rgba[i + 2] = Math.round(BRAND[2] * (1 - white) + WHITE[2] * white)
      rgba[i + 3] = Math.round(255 * bg)
    }
  }
  return rgba
}

mkdirSync(outDir, { recursive: true })
for (const size of [16, 48, 128]) {
  const file = join(outDir, `icon-${size}.png`)
  writeFileSync(file, encodePng(size, size, render(size)))
  console.log(`✓ icons/icon-${size}.png`)
}
