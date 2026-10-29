// Reminder sounds.
//   builtin     one of the tones in public/sounds (made by tools/make-sounds.mjs)
//   file        an audio file the user picked: saved by the main process on
//               desktop (served as bunmedia://), kept in IndexedDB on the web
//   soundcloud  a SoundCloud track link, played through SoundCloud's widget
// Spotify and YouTube links are not offered: Spotify only plays 30 s previews
// without Premium + its SDK, and YouTube's terms require a visible player.
// Anything that can't play (offline, iOS autoplay rules) falls back to a
// built-in tone.

import { bridge } from './api.js';

export const BUILTIN_TONES = [
  { id: 'musicbox', vi: 'Hộp nhạc', en: 'Music box' },
  { id: 'pixel', vi: 'Pixel 8-bit', en: 'Pixel 8-bit' },
  { id: 'bell', vi: 'Chuông gió', en: 'Wind chime' },
  { id: 'marimba', vi: 'Marimba', en: 'Marimba' },
];

const toneUrl = (id) => `${import.meta.env.BASE_URL}sounds/${id}.wav`;

export const isSoundCloudUrl = (url) => /^https:\/\/(www\.|m\.)?(soundcloud\.com|on\.soundcloud\.com)\/.+/i.test(String(url || '').trim());

// ---------- files picked by the user ----------

const DB_NAME = 'bun-media';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('files').objectStore('files').get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Store a picked audio File; returns the ringtone settings to save. */
export async function importToneFile(file) {
  if (file.size > 30 * 1024 * 1024) throw Object.assign(new Error('too large'), { code: 'FILE_TOO_LARGE' });
  if (bridge.isElectron) {
    const res = await bridge.invoke('ringtone:import', { name: file.name, data: await file.arrayBuffer() });
    return { kind: 'file', fileId: res.fileId, fileName: res.fileName, url: '' };
  }
  await idbPut('ringtone', file);
  return { kind: 'file', fileId: 'idb', fileName: file.name, url: '' };
}

async function fileUrl(tone) {
  if (bridge.isElectron) return `bunmedia://tone/${tone.fileId}`;
  const blob = await idbGet('ringtone');
  return blob ? URL.createObjectURL(blob) : null;
}

// ---------- iOS: unlock audio with the first tap ----------

// iOS only lets a page start sound from a tap. We play one silent sound on the
// first tap and keep reusing that same <audio> element for reminders later.
const shared = typeof Audio !== 'undefined' ? new Audio() : null;
let unlocked = false;
export function unlockAudioOnFirstTap() {
  if (!shared || bridge.isElectron) return;
  const unlock = () => {
    if (unlocked) return;
    shared.src = toneUrl('ding');
    shared.volume = 0;
    shared
      .play()
      .then(() => {
        shared.pause();
        shared.currentTime = 0;
        unlocked = true;
      })
      .catch(() => {});
  };
  window.addEventListener('pointerdown', unlock, { once: false, passive: true });
}

// ---------- playback ----------

function playAudio(src, { volume, loop, maxMs }) {
  const audio = bridge.isElectron || !shared ? new Audio() : shared;
  audio.src = src;
  audio.loop = loop;
  audio.volume = volume;
  const p = audio.play();
  const timer = maxMs ? setTimeout(() => audio.pause(), maxMs) : null;
  return {
    started: p ? p.then(() => true).catch(() => false) : Promise.resolve(true),
    stop() {
      clearTimeout(timer);
      audio.pause();
      audio.loop = false;
    },
  };
}

function playSoundCloud(url, { volume, maxMs }) {
  const frame = document.createElement('iframe');
  frame.allow = 'autoplay';
  frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none';
  frame.src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(url.trim())}&auto_play=true&visual=false&hide_related=true&show_comments=false&show_user=false&show_reposts=false`;
  let playing = false;
  let resolveStarted;
  const started = new Promise((r) => (resolveStarted = r));
  const send = (method, value) => frame.contentWindow?.postMessage(JSON.stringify(value === undefined ? { method } : { method, value }), '*');
  const onMessage = (e) => {
    if (e.source !== frame.contentWindow) return;
    let msg;
    try {
      msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if (msg.method === 'ready') {
      send('addEventListener', 'play');
      send('setVolume', Math.round(volume * 100));
      send('play');
    }
    if (msg.method === 'play') {
      playing = true;
      resolveStarted(true);
    }
  };
  window.addEventListener('message', onMessage);
  document.body.appendChild(frame);
  const giveUp = setTimeout(() => !playing && resolveStarted(false), 6000);
  const timer = maxMs ? setTimeout(() => stop(), maxMs) : null;
  function stop() {
    clearTimeout(giveUp);
    clearTimeout(timer);
    window.removeEventListener('message', onMessage);
    send('pause');
    frame.remove();
  }
  return { started, stop };
}

/**
 * Start a ringtone. Returns { stop() }. Falls back to the default tone when the
 * chosen sound can't start.
 */
export function playRingtone(tone = {}, { loop = true, maxMs = 45000 } = {}) {
  const volume = Math.max(0, Math.min(1, tone.volume ?? 0.8));
  let current = null;
  let stopped = false;
  const fallback = () => {
    if (stopped) return;
    current?.stop();
    current = playAudio(toneUrl(BUILTIN_TONES.some((x) => x.id === tone.id) ? tone.id : 'musicbox'), { volume, loop, maxMs });
  };

  (async () => {
    if (tone.kind === 'soundcloud' && isSoundCloudUrl(tone.url) && navigator.onLine !== false) {
      current = playSoundCloud(tone.url, { volume, maxMs });
      if (!(await current.started)) fallback();
    } else if (tone.kind === 'file' && tone.fileId) {
      const src = await fileUrl(tone).catch(() => null);
      if (stopped) return;
      if (!src) return fallback();
      current = playAudio(src, { volume, loop, maxMs });
      if (!(await current.started)) fallback();
    } else {
      current = playAudio(toneUrl(tone.id || 'musicbox'), { volume, loop, maxMs });
    }
  })();

  return {
    stop() {
      stopped = true;
      current?.stop();
    },
  };
}

/** A single soft chime (daily note recap). */
export function playDing(volume = 0.7) {
  return playAudio(toneUrl('ding'), { volume, loop: false, maxMs: 3000 });
}
