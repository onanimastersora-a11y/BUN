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
export function PixelSprite({ animal, anim = 'sit', scale = 3, flip = false, className, style, onEnd }) {
  const ref = useRef(null);
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
  }, [animal, anim, scale, flip, sprite]);

  return (
    <canvas
      ref={ref}
      width={sprite.width * scale}
      height={sprite.height * scale}
      className={className}
      style={{ imageRendering: 'pixelated', ...style }}
    />
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
