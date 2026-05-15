// One-shot script to generate PWA placeholder icons (solid orange with stylized "S").
// Run once with: node scripts/generate-icons.js
// Outputs public/icon-192.png, public/icon-512.png, public/apple-touch-icon.png
//
// No external deps — writes valid PNG bytes via Node's built-in zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [249, 115, 22];   // orange-500 (#f97316)
const FG = [255, 255, 255];  // white "S"

function crc32(buf) {
    if (!crc32.table) {
        crc32.table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : (c >>> 1);
            crc32.table[n] = c;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = crc32.table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Draw a simple stylized "S" using rectangle stamps on an in-memory pixel grid.
function drawS(pixels, size) {
    // S occupies the middle 60% of the canvas, vertically centered.
    const inset = Math.round(size * 0.22);
    const w = size - inset * 2;
    const h = w * 1.1;
    const startY = Math.round((size - h) / 2);
    const stroke = Math.max(2, Math.round(size * 0.12));
    const setPx = (x, y, c) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        const i = (y * size + x) * 3;
        pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2];
    };
    const rect = (x, y, rw, rh, c) => {
        for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) setPx(xx, yy, c);
    };
    // Top bar
    rect(inset, startY, w, stroke, FG);
    // Left half (top-mid)
    rect(inset, startY, stroke, Math.round(h / 2), FG);
    // Middle bar
    rect(inset, startY + Math.round(h / 2) - Math.round(stroke / 2), w, stroke, FG);
    // Right half (mid-bottom)
    rect(inset + w - stroke, startY + Math.round(h / 2), stroke, Math.round(h / 2), FG);
    // Bottom bar
    rect(inset, startY + Math.round(h) - stroke, w, stroke, FG);
}

function makePng(size) {
    // Pixel buffer: RGB
    const pixels = Buffer.alloc(size * size * 3);
    for (let i = 0; i < size * size; i++) {
        pixels[i * 3] = BG[0]; pixels[i * 3 + 1] = BG[1]; pixels[i * 3 + 2] = BG[2];
    }
    drawS(pixels, size);

    // Raw scanline data: each row prefixed with filter type byte (0 = none)
    const rowSize = 1 + size * 3;
    const raw = Buffer.alloc(rowSize * size);
    for (let y = 0; y < size; y++) {
        raw[y * rowSize] = 0;
        pixels.copy(raw, y * rowSize + 1, y * size * 3, (y + 1) * size * 3);
    }
    const compressed = zlib.deflateSync(raw);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // color type RGB
    // 10, 11, 12 = 0 (compression, filter, interlace)

    const magic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    return Buffer.concat([magic, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, '..', 'public');
const sizes = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180 };
for (const [name, size] of Object.entries(sizes)) {
    const buf = makePng(size);
    const file = path.join(outDir, name);
    fs.writeFileSync(file, buf);
    console.log(`Wrote ${file} (${buf.length} bytes, ${size}x${size})`);
}
console.log('Done.');
