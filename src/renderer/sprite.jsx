// Pixel sprite rendering. Sprite data lives in src/sprites/<animal>.js as
// character grids; each frame is rasterised once into a 1x canvas and then
// blitted at an integer scale with smoothing off, which keeps pixels crisp.

import { useEffect, useRef } from 'react';
import cat from '../sprites/cat.js';
import dog from '../sprites/dog.js';

export const SPRITES = { cat, dog };

const frameCache = new Map();
const urlCache = new Map();

function rasterise(sprite, rows) {
  const h = rows.length;
  const w = rows[0].length;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      ctx.fillStyle = sprite.palette[ch];
      ctx.fillRect(x, y, 1, 1);
    }
  });
  return canvas;
}

export function frameCanvas(animal, frame) {
  const key = `${animal}:${frame}`;
  if (!frameCache.has(key)) {
    const sprite = SPRITES[animal];
    const rows = frame === '@icon' ? sprite.icon : sprite.frames[frame];
    frameCache.set(key, rasterise(sprite, rows));
  }
  return frameCache.get(key);
}

// Data URL of a single frame (or the 16x16 icon) for use in <img>.
export function spriteUrl(animal, frame = '@icon') {
  const key = `${animal}:${frame}`;
  if (!urlCache.has(key)) urlCache.set(key, frameCanvas(animal, frame).toDataURL());
  return urlCache.get(key);
}

// Which frame of an animation is showing `elapsed` ms after it started.
export function frameAt(def, elapsed) {
  const total = def.seq.reduce((s, [, ms]) => s + ms, 0);
  if (!def.loop && elapsed >= total) return { frame: def.seq[def.seq.length - 1][0], done: true };
  let t = def.loop ? elapsed % total : elapsed;
  for (const [frame, ms] of def.seq) {
    if (t < ms) return { frame, done: false };
    t -= ms;
  }
  return { frame: def.seq[def.seq.length - 1][0], done: !def.loop };
}

export function animationLength(animal, anim) {
  return SPRITES[animal].animations[anim].seq.reduce((s, [, ms]) => s + ms, 0);
}

// ---------- party hat (greetings) ----------
// Drawn on its own canvas that starts HAT_ROWS above the frame, since a hat on
// the head pokes out of the 48x40 frame.

export const HAT_ROWS = 12;
const HAT_W = 11;
const HAT_COLORS = { o: '#3d2b26', w: '#fdf8ee', p: '#f29aa0', y: '#f5c443', b: '#74a6dc' };
// Pom-pom on top, then a cone with diagonal stripes, widening by one pixel every two rows.
const HAT = Array.from({ length: HAT_ROWS }, (_, r) =>
  Array.from({ length: HAT_W }, (_, c) => {
    const dx = c - 5;
    if (r === 0 || r === 2) return Math.abs(dx) <= 1 ? 'o' : '.';
    if (r === 1) return Math.abs(dx) === 2 ? 'o' : Math.abs(dx) < 2 ? 'w' : '.';
    const half = Math.floor((r - 3) / 2) + 1;
    if (Math.abs(dx) > half) return '.';
    if (Math.abs(dx) === half || r === HAT_ROWS - 1) return 'o';
    return 'pyb'[Math.floor((dx + 5 + r) / 2) % 3];
  }).join(''),
);

const hatColumns = new Map();
// The head's middle column, from the sitting pose: halfway between the outermost
// pixels of its top row (the dog's crown, the cat's two ear tips).
function hatColumn(animal) {
  if (!hatColumns.has(animal)) {
    const rows = SPRITES[animal].frames[SPRITES[animal].animations.sit.seq[0][0]];
    const top = rows.find((row) => /[^.]/.test(row));
    hatColumns.set(animal, Math.round((top.search(/[^.]/) + top.length - 1 - [...top].reverse().join('').search(/[^.]/)) / 2));
  }
  return hatColumns.get(animal);
}

/** Where a hat sits on `frame`: its middle column, and the row its brim covers. */
export function hatSpot(animal, frame, flip = false) {
  const sprite = SPRITES[animal];
  const rows = sprite.frames[frame];
  const cx = hatColumn(animal);
  let top = rows.findIndex((row) => /[^.]/.test(row.slice(cx - 3, cx + 4)));
  if (top < 0) top = 0;
  return { cx: flip ? sprite.width - 1 - cx : cx, brim: top + 1 };
}

/** Draw the hat on the overlay canvas (row 0 of the overlay is HAT_ROWS above the frame). */
export function drawHat(ctx, { cx, brim }, scale) {
  const left = cx - (HAT_W - 1) / 2;
  const top = brim + 1; // = brim - (HAT_ROWS - 1) + HAT_ROWS
  HAT.forEach((row, r) => {
    for (let c = 0; c < HAT_W; c++) {
      const ch = row[c];
      if (ch === '.') continue;
      ctx.fillStyle = HAT_COLORS[ch];
      ctx.fillRect((left + c) * scale, (top + r) * scale, scale, scale);
    }
  });
}

export function drawFrame(ctx, animal, frame, x, y, scale, flip = false) {
  const img = frameCanvas(animal, frame);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (flip) {
    ctx.translate(x + img.width * scale, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 0, 0, img.width * scale, img.height * scale);
  } else {
    ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
  }
  ctx.restore();
}

/** Animated sprite on its own canvas (used in the main window). */
export function PixelSprite({ animal, anim = 'sit', scale = 3, flip = false, hat = false, className, style, onEnd }) {
  const ref = useRef(null);
  const hatRef = useRef(null);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  const sprite = SPRITES[animal];

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    const def = sprite.animations[anim];
    let raf;
    let last = null;
    let ended = false;
    const t0 = performance.now();
    const loop = (now) => {
      const { frame, done } = frameAt(def, now - t0);
      if (frame !== last) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawFrame(ctx, animal, frame, 0, 0, scale, flip);
        const hatCtx = hatRef.current?.getContext('2d');
        if (hatCtx) {
          hatCtx.clearRect(0, 0, hatCtx.canvas.width, hatCtx.canvas.height);
          drawHat(hatCtx, hatSpot(animal, frame, flip), scale);
        }
        last = frame;
      }
      if (done && !ended) {
        ended = true;
        endRef.current?.();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animal, anim, scale, flip, hat, sprite]);

  const canvas = (
    <canvas
      ref={ref}
      width={sprite.width * scale}
      height={sprite.height * scale}
      className={hat ? undefined : className}
      style={{ imageRendering: 'pixelated', ...(hat ? { display: 'block' } : style) }}
    />
  );
  if (!hat) return canvas;
  return (
    <span className={className} style={{ position: 'relative', display: 'inline-block', ...style }}>
      {canvas}
      <canvas
        ref={hatRef}
        width={sprite.width * scale}
        height={(HAT_ROWS + 16) * scale}
        style={{ position: 'absolute', left: 0, top: -HAT_ROWS * scale, imageRendering: 'pixelated', pointerEvents: 'none' }}
      />
    </span>
  );
}

/** Small pixel head used for avatars. */
export function PetAvatar({ animal = 'cat', size = 32, className = '' }) {
  return (
    <span className={`pet-avatar pet-avatar--${animal} ${className}`} style={{ width: size, height: size }}>
      <img src={spriteUrl(animal)} alt="" draggable={false} style={{ width: size * 0.78, height: size * 0.78 }} />
    </span>
  );
}
