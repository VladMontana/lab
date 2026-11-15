import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const inputPath = 'C:/Users/Влад/.gemini/antigravity/brain/d72f03ef-c46f-4fcd-bd17-b2c822b0da35/.user_uploaded/media_1794745290062_bd54a085.png';
const publicDir = path.resolve(import.meta.dirname, '../public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// 1. Decode original PNG
const buf = fs.readFileSync(inputPath);
let offset = 8;
const idatChunks = [];
while (offset < buf.length) {
  const len = buf.readUInt32BE(offset);
  const type = buf.toString('ascii', offset + 4, offset + 8);
  if (type === 'IDAT') idatChunks.push(buf.subarray(offset + 8, offset + 8 + len));
  offset += 12 + len;
}
const raw = zlib.inflateSync(Buffer.concat(idatChunks));
const width = 41, height = 40;
const bpp = 4;
const stride = 1 + width * bpp;

const image = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) {
  const filter = raw[y * stride];
  const rowStart = y * stride + 1;
  const prevRowStart = (y - 1) * width * 4;
  const outRowStart = y * width * 4;

  for (let x = 0; x < width * 4; x++) {
    const rawVal = raw[rowStart + x];
    const a = x >= bpp ? image[outRowStart + x - bpp] : 0;
    const b = y > 0 ? image[prevRowStart + x] : 0;
    const c = y > 0 && x >= bpp ? image[prevRowStart + x - bpp] : 0;

    let val = 0;
    if (filter === 0) val = rawVal;
    else if (filter === 1) val = (rawVal + a) & 0xff;
    else if (filter === 2) val = (rawVal + b) & 0xff;
    else if (filter === 3) val = (rawVal + Math.floor((a + b) / 2)) & 0xff;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      val = (rawVal + pr) & 0xff;
    }
    image[outRowStart + x] = val;
  }
}

// 2. Identify Book Pixels in 32x32 grid
const outW = 32, outH = 32;
const minX = 16, maxX = 34, minY = 8, maxY = 31;
const bookW = maxX - minX + 1; // 19
const bookH = maxY - minY + 1; // 24
const targetX = Math.floor((outW - bookW) / 2); // 6
const targetY = Math.floor((outH - bookH) / 2); // 4

interface Pixel {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

const pixels: Pixel[] = [];
const outRgba = Buffer.alloc(outW * outH * 4, 0);

for (let by = 0; by < bookH; by++) {
  for (let bx = 0; bx < bookW; bx++) {
    const srcX = minX + bx;
    const srcY = minY + by;
    const srcP = (srcY * width + srcX) * 4;
    const r = image[srcP], g = image[srcP + 1], b = image[srcP + 2];

    // Background tolerance (#f7f6f3)
    const bgDist = Math.abs(r - 247) + Math.abs(g - 246) + Math.abs(b - 243);
    if (bgDist <= 12) continue; // Skip background

    const dstX = targetX + bx;
    const dstY = targetY + by;
    const dstP = (dstY * outW + dstX) * 4;

    let pr = r, pg = g, pb = b, pa = 255;
    // Edge shadow pixel handling
    if (r > 165 && g > 165 && b > 165 && (bx === 0 || bx === bookW - 1 || by === 0 || by === bookH - 1)) {
      pa = Math.max(30, Math.min(180, Math.round(255 * (1 - (r / 247)))));
      pr = 30; pg = 30; pb = 30;
    }

    outRgba[dstP] = pr;
    outRgba[dstP + 1] = pg;
    outRgba[dstP + 2] = pb;
    outRgba[dstP + 3] = pa;

    pixels.push({ x: dstX, y: dstY, r: pr, g: pg, b: pb, a: pa });
  }
}

// 3. Generate SVG (crisp pixel art SVG)
let svgElements = '';
for (const p of pixels) {
  const hex = '#' + [p.r, p.g, p.b].map(v => v.toString(16).padStart(2, '0')).join('');
  const opacity = p.a < 255 ? ` opacity="${(p.a / 255).toFixed(2)}"` : '';
  svgElements += `  <rect x="${p.x}" y="${p.y}" width="1" height="1" fill="${hex}"${opacity}/>\n`;
}

const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%" shape-rendering="crispEdges">
${svgElements}</svg>`;

fs.writeFileSync(path.join(publicDir, 'favicon.svg'), svgContent, 'utf8');
fs.writeFileSync(path.join(publicDir, 'book-icon.svg'), svgContent, 'utf8');
console.log('✓ Generated favicon.svg and book-icon.svg');

// 4. Generate PNG Encoder Helpers
function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}
const crcTable = makeCrcTable();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type: string, data: Buffer): Buffer {
  const len = data.length;
  const chunk = Buffer.alloc(12 + len);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  const typeAndData = chunk.subarray(4, 8 + len);
  const crc = crc32(typeAndData);
  chunk.writeUInt32BE(crc, 8 + len);
  return chunk;
}

function encodePng(w: number, h: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // Deflate
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // No interlace
  const ihdrChunk = createChunk('IHDR', ihdr);

  // Scanlines with filter byte 0
  const scanlines = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    scanlines[y * (1 + w * 4)] = 0; // None filter
    rgba.copy(scanlines, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }

  const idatData = zlib.deflateSync(scanlines, { level: 9 });
  const idatChunk = createChunk('IDAT', idatData);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

// Write 32x32 PNG
const png32 = encodePng(outW, outH, outRgba);
fs.writeFileSync(path.join(publicDir, 'favicon.png'), png32);
fs.writeFileSync(path.join(publicDir, 'book-icon.png'), png32);
console.log('✓ Generated favicon.png and book-icon.png (32x32)');

// 5. Generate Upscaled 192x192 and 512x512 PNGs for Apple Touch Icon & PWA
function upscaleNearest(w: number, h: number, srcRgba: Buffer, scale: number): Buffer {
  const dstW = w * scale;
  const dstH = h * scale;
  const dst = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const srcY = Math.floor(y / scale);
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.floor(x / scale);
      const srcP = (srcY * w + srcX) * 4;
      const dstP = (y * dstW + x) * 4;
      dst[dstP] = srcRgba[srcP];
      dst[dstP + 1] = srcRgba[srcP + 1];
      dst[dstP + 2] = srcRgba[srcP + 2];
      dst[dstP + 3] = srcRgba[srcP + 3];
    }
  }
  return dst;
}

const png192 = encodePng(32 * 6, 32 * 6, upscaleNearest(32, 32, outRgba, 6));
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), png192);
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), png192);
console.log('✓ Generated apple-touch-icon.png (192x192)');

// 6. Generate ICO wrapping 32x32 PNG
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(0, 0); // reserved
icoHeader.writeUInt16LE(1, 2); // icon type
icoHeader.writeUInt16LE(1, 4); // 1 image

const icoDir = Buffer.alloc(16);
icoDir[0] = 32; // width
icoDir[1] = 32; // height
icoDir[2] = 0;  // palette count
icoDir[3] = 0;  // reserved
icoDir.writeUInt16LE(1, 4); // color planes
icoDir.writeUInt16LE(32, 6); // bpp
icoDir.writeUInt32LE(png32.length, 8); // size
icoDir.writeUInt32LE(22, 12); // offset (6 + 16)

const ico = Buffer.concat([icoHeader, icoDir, png32]);
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), ico);
console.log('✓ Generated favicon.ico');

console.log('🎉 All icons successfully generated!');
