// Render sprite frames to PNG sheets for previewing pixel art.
// Usage: node tools/render-sprites.mjs <cat|dog> [outDir] [scale]
// Writes one PNG per animation (frames laid out left -> right, in sequence order,
// duplicates skipped) plus an "all-frames" sheet and the icon.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hexToRgba(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), v.length === 8 ? parseInt(v.slice(6, 8), 16) : 255];
}

// Lay out frames on a checker background (so transparency is visible) with a 1px gap.
function renderSheet(sprite, frameNames, scale, w = sprite.width, h = sprite.height, getRows = (n) => sprite.frames[n]) {
  const gap = 4;
  const W = (w * scale + gap) * frameNames.length + gap;
  const H = h * scale + gap * 2;
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const checker = ((x >> 3) + (y >> 3)) & 1 ? 225 : 240;
      buf[i] = checker; buf[i + 1] = checker; buf[i + 2] = checker; buf[i + 3] = 255;
    }
  const pal = Object.fromEntries(Object.entries(sprite.palette).map(([k, v]) => [k, hexToRgba(v)]));
  frameNames.forEach((name, fi) => {
    const rows = getRows(name);
    if (!rows) throw new Error(`Missing frame "${name}"`);
    if (rows.length !== h) throw new Error(`Frame "${name}" has ${rows.length} rows, expected ${h}`);
    rows.forEach((row, ry) => {
      if (row.length !== w) throw new Error(`Frame "${name}" row ${ry} has ${row.length} chars, expected ${w}`);
      [...row].forEach((ch, rx) => {
        if (ch === '.') return;
        const c = pal[ch];
        if (!c) throw new Error(`Frame "${name}" row ${ry}: unknown palette key "${ch}"`);
        const ox = gap + fi * (w * scale + gap) + rx * scale;
        const oy = gap + ry * scale;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const i = ((oy + dy) * W + ox + dx) * 4;
            const a = c[3] / 255;
            buf[i] = Math.round(c[0] * a + buf[i] * (1 - a));
            buf[i + 1] = Math.round(c[1] * a + buf[i + 1] * (1 - a));
            buf[i + 2] = Math.round(c[2] * a + buf[i + 2] * (1 - a));
          }
      });
    });
  });
  return encodePNG(W, H, buf);
}

async function main() {
  const which = process.argv[2] || 'cat';
  const outDir = resolve(process.argv[3] || 'sprite-preview');
  const scale = Number(process.argv[4] || 6);
  const mod = await import(pathToFileURL(resolve(`src/sprites/${which}.js`)).href + `?t=${Date.now()}`);
  const sprite = mod.default;
  mkdirSync(outDir, { recursive: true });
  for (const [anim, def] of Object.entries(sprite.animations)) {
    const names = [...new Set(def.seq.map(([n]) => n))];
    const file = join(outDir, `${which}-${anim}.png`);
    writeFileSync(file, renderSheet(sprite, names, scale));
    const total = def.seq.reduce((s, [, ms]) => s + ms, 0);
    console.log(`${anim.padEnd(8)} ${names.length} frames, ${def.seq.length} steps, ${total} ms -> ${file}`);
  }
  writeFileSync(join(outDir, `${which}-all.png`), renderSheet(sprite, Object.keys(sprite.frames), Math.max(2, scale - 2)));
  if (sprite.icon) {
    const ih = sprite.icon.length, iw = sprite.icon[0].length;
    writeFileSync(join(outDir, `${which}-icon.png`), renderSheet(sprite, ['icon'], scale * 2, iw, ih, () => sprite.icon));
  }
  console.log(`OK: ${Object.keys(sprite.frames).length} frames validated`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
