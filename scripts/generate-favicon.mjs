import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const publicDir = resolve(__dirname, '../public')

// Recreate the SVG design as a raw pixel buffer via SVG → sharp
const svg = `<svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="32" height="32" rx="8" fill="#0F1419"/>
  <rect x="8" y="9" width="16" height="3" rx="1" fill="white" opacity="0.9"/>
  <rect x="8" y="14.5" width="16" height="3" rx="1" fill="#A78BFA"/>
  <rect x="8" y="20" width="16" height="3" rx="1" fill="#8B5CF6"/>
</svg>`

// 32x32 PNG
const png32 = await sharp(Buffer.from(svg)).png().toBuffer()
writeFileSync(resolve(publicDir, 'favicon.png'), png32)
console.log('✓ favicon.png (32×32)')

// 16x16 version
const png16 = await sharp(Buffer.from(svg)).resize(16, 16).png().toBuffer()
console.log('✓ favicon 16×16 ready')

// 48x48 for apple-touch-icon
const png48 = await sharp(Buffer.from(svg)).resize(48, 48).png().toBuffer()
writeFileSync(resolve(publicDir, 'apple-touch-icon.png'), png48)
console.log('✓ apple-touch-icon.png (48×48)')

// Build ICO: modern ICO = ICONDIR header + ICONDIRENTRY × n + raw PNG data
function buildIco(images) {
  const count = images.length
  const headerSize = 6
  const entrySize = 16
  const dataOffset = headerSize + entrySize * count

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)     // reserved
  header.writeUInt16LE(1, 2)     // type: ICO
  header.writeUInt16LE(count, 4) // image count

  let currentOffset = dataOffset
  const entries = []
  for (const img of images) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(img.size === 256 ? 0 : img.size, 0)  // width (0 = 256)
    entry.writeUInt8(img.size === 256 ? 0 : img.size, 1)  // height
    entry.writeUInt8(0, 2)  // color count
    entry.writeUInt8(0, 3)  // reserved
    entry.writeUInt16LE(1, 4)  // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(img.data.length, 8)  // size of image data
    entry.writeUInt32LE(currentOffset, 12)   // offset
    currentOffset += img.data.length
    entries.push(entry)
  }

  return Buffer.concat([header, ...entries, ...images.map(i => i.data)])
}

const ico = buildIco([
  { size: 16, data: png16 },
  { size: 32, data: png32 },
])
writeFileSync(resolve(publicDir, 'favicon.ico'), ico)
console.log('✓ favicon.ico (16×16 + 32×32 embedded PNGs)')
