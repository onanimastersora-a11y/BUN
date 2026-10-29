// Draws the BUN logo as a 32x32 pixel grid and exports:
//   build/icon.png                    1024px, electron-builder icon for Windows + macOS
//   electron/assets/icon.png          256px, window icon
//   electron/assets/tray.png          32px, Windows tray icon
//   electron/assets/trayTemplate*.png black silhouette for the macOS menu bar
//   public/icons/*                    web / iPhone app icons (Home Screen, notifications)
//   src/renderer/assets/logo.svg      crisp vector version for the UI
// The mascot is a round "bun" with one cat ear and one floppy dog ear (for cat
// people and dog people), on the app's blue.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodePNG } from './render-sprites.mjs';

const N = 32;
const C = {
  outline: [46, 38, 34],
  cream: [255, 247, 234],
  creamShade: [242, 228, 208],
  pink: [243, 165, 181],
  tan: [224, 160, 98],
  tanDark: [196, 128, 70],
  eye: [46, 38, 34],
};

function drawLogo(withTile) {
  const grid = Array.from({ length: N }, () => Array(N).fill(null));
  const set = (x, y, c) => {
    if (x >= 0 && y >= 0 && x < N && y < N) grid[y][x] = c;
  };

  // Tile: rounded square with a soft vertical blue gradient.
  const R = 7;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const cx = Math.min(Math.max(x + 0.5, R), N - R);
      const cy = Math.min(Math.max(y + 0.5, R), N - R);
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > R * R) continue;
      if (withTile) set(x, y, gradient(y, N));
    }

  // Paint a shape: 1px outline ring around the mask, then the fill on top.
  function shape(test, fill, shade) {
    const mask = (x, y) => x >= 0 && y >= 0 && x < N && y < N && test(x + 0.5, y + 0.5);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++)
        if (!mask(x, y) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => mask(x + dx, y + dy))) set(x, y, C.outline);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) if (mask(x, y)) set(x, y, shade && shade(x + 0.5, y + 0.5) ? shade.color : fill);
  }

  const inTri = (px, py, [ax, ay], [bx, by], [cx, cy]) => {
    const s = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
    const d1 = s(px, py, ax, ay, bx, by), d2 = s(px, py, bx, by, cx, cy), d3 = s(px, py, cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };

  const HX = 15.5, HY = 18.5, HR = 9.6;

  // Cat ear (left, behind the head) with pink inside.
  shape((x, y) => inTri(x, y, [6.4, 4.2], [6.6, 13.6], [14, 10.5]), C.cream);
  shape((x, y) => inTri(x, y, [7.4, 6.8], [7.2, 13], [11.6, 10.6]), C.pink);
  // Head.
  shape(
    (x, y) => ((x - HX) / HR) ** 2 + ((y - HY) / (HR * 0.92)) ** 2 <= 1,
    C.cream,
    Object.assign((x, y) => y > HY + 5.2, { color: C.creamShade }),
  );
  // Floppy dog ear (right, in front of the head edge).
  const ear = (x, y) => {
    const a = (24 * Math.PI) / 180;
    const dx = x - 24.2, dy = y - 16.4;
    const rx = dx * Math.cos(a) - dy * Math.sin(a);
    const ry = dx * Math.sin(a) + dy * Math.cos(a);
    return (rx / 2.7) ** 2 + (ry / 6.2) ** 2 <= 1;
  };
  shape(ear, C.tan, Object.assign((x, y) => y > 19.5, { color: C.tanDark }));

  // Face.
  for (const [x, y] of [[11, 17], [11, 18], [12, 17], [12, 18], [18, 17], [18, 18], [19, 17], [19, 18]]) set(x, y, C.eye);
  for (const [x, y] of [[9, 20], [10, 20], [20, 20], [21, 20]]) set(x, y, C.pink);
  for (const [x, y] of [[13, 20], [14, 21], [15, 20], [16, 21], [17, 20]]) set(x, y, C.eye);
  return grid;
}

const gradient = (y, n) => {
  const k = y / (n - 1);
  return [Math.round(84 - 26 * k), Math.round(160 - 30 * k), Math.round(234 - 24 * k)];
};

const grid = drawLogo(true);
const mascot = drawLogo(false);

// ---------- export ----------

// Render a grid at an integer scale, centred on a square canvas of `size`.
// bg: 'gradient' fills the whole square (iOS icons must be opaque);
// mono: paint every pixel in one colour (badges / menu-bar templates).
function png(g, scale, { size = N * scale, bg = null, mono = null } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const off = Math.floor((size - N * scale) / 2);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const gx = Math.floor((x - off) / scale);
      const gy = Math.floor((y - off) / scale);
      let c = gx >= 0 && gy >= 0 && gx < N && gy < N ? g[gy][gx] : null;
      if (c && mono) c = mono;
      if (!c && bg === 'gradient') c = gradient(y, size);
      if (!c) continue;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
    }
  return encodePNG(size, size, buf);
}

function svg() {
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const rects = [];
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const c = grid[y][x];
      if (!c) { x++; continue; }
      let w = 1;
      while (x + w < N && grid[y][x + w] && hex(grid[y][x + w]) === hex(c)) w++;
      rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1" fill="${hex(c)}"/>`);
      x += w;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges">${rects.join('')}</svg>\n`;
}

// 16x16 silhouette for the macOS menu bar (2x2 blocks of the 32 grid).
function half(g) {
  const h = Array.from({ length: N }, () => Array(N).fill(null));
  for (let y = 0; y < N; y += 2)
    for (let x = 0; x < N; x += 2) {
      const on = g[y][x] || g[y + 1][x] || g[y][x + 1] || g[y + 1][x + 1];
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) h[y + dy][x + dx] = on;
    }
  return h;
}

const out = (file, data) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log('wrote', file);
};
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
out('build/icon.png', png(grid, 32));
out('electron/assets/icon.png', png(grid, 8));
out('electron/assets/tray.png', png(grid, 1));
out('electron/assets/trayTemplate.png', png(half(mascot), 0.5, { size: 16, mono: BLACK }));
out('electron/assets/trayTemplate@2x.png', png(mascot, 1, { mono: BLACK }));
out('public/icons/apple-touch-icon.png', png(mascot, 5, { size: 180, bg: 'gradient' }));
out('public/icons/icon-192.png', png(grid, 6));
out('public/icons/icon-512.png', png(grid, 16));
out('public/icons/icon-maskable-512.png', png(mascot, 12, { size: 512, bg: 'gradient' }));
out('public/icons/badge-96.png', png(mascot, 3, { mono: WHITE }));
out('src/renderer/assets/logo.svg', svg());
if (process.argv[2]) out(process.argv[2], png(mascot, 5, { size: 180, bg: 'gradient' }));
