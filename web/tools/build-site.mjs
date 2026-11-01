#!/usr/bin/env node
// Build the BUN landing page into ONE self-contained HTML file.
//
//   node web/tools/build-site.mjs
//
// Reads   web/site/index.html               (template with @@PLACEHOLDERS@@)
//         src/sprites/cat.js, src/sprites/dog.js   (pixel pets, ES modules)
//         src/renderer/assets/logo.svg       (32x32 pixel logo)
// Writes  web/public/index.html              (served at the site root)
//
// Only the animations the page uses are inlined (frames are run-length encoded).
// The optional `play` animation is picked up automatically when a sprite has it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const ROOT = resolve(WEB, '..');
const TEMPLATE = resolve(WEB, 'site/index.html');
const OUT = resolve(WEB, 'public/index.html');
const LOGO = resolve(ROOT, 'src/renderer/assets/logo.svg');
const SPRITE_FILES = { cat: resolve(ROOT, 'src/sprites/cat.js'), dog: resolve(ROOT, 'src/sprites/dog.js') };

// Animations used by the page. Missing optional ones are skipped.
const ANIMS = ['sit', 'walk', 'liedown', 'sleep', 'stretch', 'alert'];
const OPTIONAL_ANIMS = ['play'];

const rel = (p) => relative(ROOT, p).replaceAll('\\', '/');

// ---------- sprites ----------
function rle(str) {
  let out = '';
  for (let i = 0; i < str.length; ) {
    let n = 1;
    while (str[i + n] === str[i]) n++;
    out += n > 1 ? n + str[i] : str[i];
    i += n;
  }
  return out;
}

function packSprite(name, sp) {
  const { width: w, height: h } = sp;
  // RLE uses digits as counts, so palette keys must not be digits.
  const canRle = Object.keys(sp.palette).every((k) => !/\d/.test(k));
  const enc = (rows, ew, eh, label) => {
    if (!Array.isArray(rows) || rows.length !== eh) throw new Error(`${name}: "${label}" must have ${eh} rows`);
    rows.forEach((r, y) => {
      if (r.length !== ew) throw new Error(`${name}: "${label}" row ${y} has ${r.length} chars, expected ${ew}`);
      for (const ch of r) if (ch !== '.' && !(ch in sp.palette)) throw new Error(`${name}: "${label}" uses unknown palette key "${ch}"`);
    });
    const flat = rows.join('');
    return canRle ? rle(flat) : flat;
  };

  const used = [...ANIMS, ...OPTIONAL_ANIMS.filter((a) => sp.animations?.[a])];
  const anims = {};
  const frameNames = new Set();
  for (const a of used) {
    const def = sp.animations?.[a];
    if (!def) {
      if (ANIMS.includes(a)) throw new Error(`${name}: missing animation "${a}"`);
      continue;
    }
    anims[a] = { loop: !!def.loop, seq: def.seq.map(([f, ms]) => [f, ms]) };
    def.seq.forEach(([f]) => frameNames.add(f));
  }
  const frames = {};
  for (const f of frameNames) {
    if (!sp.frames[f]) throw new Error(`${name}: animation uses missing frame "${f}"`);
    frames[f] = enc(sp.frames[f], w, h, f);
  }
  const out = { w, h, rle: canRle, pal: sp.palette, frames, anims, meta: sp.meta || {} };
  if (sp.icon) {
    out.iconSize = sp.icon.length;
    out.icon = enc(sp.icon, sp.icon[0].length, sp.icon.length, 'icon');
  }
  return { data: out, used: Object.keys(anims), frameCount: frameNames.size, totalFrames: Object.keys(sp.frames).length };
}

// ---------- logo ----------
// The logo is 182 <rect>s; merge them into one <path> per colour (same pixels, ~3x smaller).
function optimiseLogo(svg) {
  const open = svg.match(/<svg\b[^>]*>/);
  const rects = [...svg.matchAll(/<rect\b([^>]*)\/>/g)];
  const rest = svg.replace(/<svg\b[^>]*>|<\/svg>|<rect\b[^>]*\/>/g, '').trim();
  if (!open || !rects.length || rest) return svg.trim(); // unexpected shape: keep as-is
  const attr = (s, k) => (s.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1];
  const byFill = new Map();
  for (const [, a] of rects) {
    const x = attr(a, 'x') || '0', y = attr(a, 'y') || '0', w = attr(a, 'width'), h = attr(a, 'height'), fill = attr(a, 'fill');
    if (!w || !h || !fill) return svg.trim();
    byFill.set(fill, (byFill.get(fill) || '') + `M${x} ${y}h${w}v${h}h-${w}z`);
  }
  const viewBox = attr(open[0], 'viewBox') || '0 0 32 32';
  const paths = [...byFill].map(([fill, d]) => `<path fill="${fill}" d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" shape-rendering="crispEdges">${paths}</svg>`;
}

// ---------- build ----------
async function main() {
  let html = readFileSync(TEMPLATE, 'utf8');

  const sprites = {};
  const report = [];
  for (const [name, file] of Object.entries(SPRITE_FILES)) {
    const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
    const packed = packSprite(name, mod.default);
    sprites[name] = packed.data;
    report.push(`  ${name}: ${packed.used.join(', ')} (${packed.frameCount}/${packed.totalFrames} frames)`);
  }
  // Safe inside <script type="application/json">.
  const spritesJson = JSON.stringify(sprites).replace(/</g, '\\u003c');

  const logo = optimiseLogo(readFileSync(LOGO, 'utf8'));
  const inlineLogo = logo.replace('<svg ', '<svg width="64" height="64" aria-hidden="true" focusable="false" ');
  const favicon = 'data:image/svg+xml,' + encodeURIComponent(logo).replace(/'/g, '%27');

  const date = new Date().toISOString().slice(0, 10);
  const banner =
    `Generated by web/tools/build-site.mjs on ${date} from web/site/index.html. ` +
    'Edit the template and rebuild (node web/tools/build-site.mjs). ' +
    'Quick edit: GITHUB_REPO / APP_URL / VERSION are at the top of the main script near the end of this file.';

  const fills = {
    '@@FAVICON@@': favicon,
    '<!--@@LOGO_SVG@@-->': inlineLogo,
    '@@SPRITES_JSON@@': spritesJson,
    '<!-- @@BUILD_INFO@@ -->': `<!-- ${banner} -->`,
  };
  for (const [key, value] of Object.entries(fills)) {
    if (!html.includes(key)) throw new Error(`Template is missing placeholder ${key}`);
    html = html.split(key).join(value);
  }
  // The page always shows the version of the apps being released (package.json).
  const { version } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  if (!/const VERSION = '[^']*';/.test(html)) throw new Error('Template is missing const VERSION');
  html = html.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
  // Drop the template-only comment block in <head>.
  html = html.replace(/<!--\s*\n\s*BUN landing page: SOURCE TEMPLATE[\s\S]*?-->\n/, '');
  const left = html.match(/@@[A-Z_]+@@/);
  if (left) throw new Error(`Unfilled placeholder ${left[0]}`);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html);
  // Home Screen install from the landing page opens the app, not this page.
  writeFileSync(
    join(dirname(OUT), 'manifest.webmanifest'),
    JSON.stringify(
      {
        name: 'BUN',
        short_name: 'BUN',
        start_url: '/app/',
        scope: '/',
        display: 'standalone',
        background_color: '#f6f2ec',
        theme_color: '#f6f2ec',
        icons: [
          { src: '/app/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/app/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/app/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      null,
      2,
    ),
  );
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`Built ${rel(OUT)}  ${kb(Buffer.byteLength(html))}  (sprites ${kb(spritesJson.length)}, logo ${kb(logo.length)})`);
  console.log(report.join('\n'));
}

main().catch((err) => {
  console.error('build-site failed:', err.message);
  process.exit(1);
});
