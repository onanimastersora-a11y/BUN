// Synthesises BUN's built-in reminder tones into public/sounds/*.wav
// (22.05 kHz mono 16-bit). Each tone is a short phrase followed by a little
// silence so it loops nicely while a reminder is ringing.
import { mkdirSync, writeFileSync } from 'node:fs';

const RATE = 22050;
const note = (n) => 440 * 2 ** ((n - 69) / 12); // MIDI -> Hz

function render(seconds, voices) {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (const v of voices) {
    const start = Math.round(v.at * RATE);
    const len = Math.round(v.dur * RATE);
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / RATE;
      const attack = Math.min(1, t / (v.attack ?? 0.004));
      const env = attack * Math.exp(-t * (v.decay ?? 4));
      out[start + i] += v.wave(t) * env * (v.gain ?? 0.3);
    }
  }
  // Soft limiter + fade out.
  for (let i = 0; i < out.length; i++) {
    const fade = Math.min(1, (out.length - i) / (0.05 * RATE));
    out[i] = Math.tanh(out[i] * 1.2) * fade;
  }
  return out;
}

const sine = (f) => (t) => Math.sin(2 * Math.PI * f * t);
const musicBoxWave = (f) => (t) => Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t * 6) + 0.12 * Math.sin(2 * Math.PI * f * 3.01 * t) * Math.exp(-t * 9);
const square = (f) => (t) => (Math.sin(2 * Math.PI * f * t) >= 0 ? 0.55 : -0.55);
const bellWave = (f) => (t) => [1, 2.76, 5.4, 8.93].reduce((s, r, k) => s + Math.sin(2 * Math.PI * f * r * t) * Math.exp(-t * (1.5 + k * 2.2)) / (k + 1), 0);
const marimbaWave = (f) => (t) => Math.sin(2 * Math.PI * f * t) + 0.25 * Math.sin(2 * Math.PI * f * 4 * t) * Math.exp(-t * 25);

const tones = {
  // Hộp nhạc: a gentle music-box phrase.
  musicbox: () =>
    render(3.2, [72, 76, 79, 84, 83, 79, 81, 76].map((n, i) => ({ at: i * 0.22, dur: 1.6, wave: musicBoxWave(note(n + 12)), decay: 3.2, gain: 0.26 }))),
  // Pixel: an 8-bit jingle that fits the pixel pets.
  pixel: () =>
    render(2.6, [
      ...[72, 76, 79, 84].map((n, i) => ({ at: i * 0.09, dur: 0.12, wave: square(note(n)), decay: 6, gain: 0.34 })),
      ...[79, 84].map((n, i) => ({ at: 0.5 + i * 0.14, dur: 0.18, wave: square(note(n)), decay: 5, gain: 0.34 })),
      { at: 0.8, dur: 0.5, wave: square(note(88)), decay: 3, gain: 0.3 },
    ]),
  // Chuông gió: soft wind-chime strikes.
  bell: () => render(3.6, [86, 81, 88, 84, 91].map((n, i) => ({ at: i * 0.38 + (i % 2) * 0.05, dur: 2.6, wave: bellWave(note(n)), decay: 1.2, gain: 0.22 }))),
  // Marimba: a playful bouncy pattern.
  marimba: () =>
    render(2.8, [67, 71, 74, 79, 74, 79, 83].map((n, i) => ({ at: i * 0.16 + (i > 3 ? 0.12 : 0), dur: 0.7, wave: marimbaWave(note(n)), decay: 7, gain: 0.3 }))),
  // Ding: a single soft chime (daily note recap).
  ding: () => render(1.6, [{ at: 0, dur: 1.5, wave: bellWave(note(84)), decay: 2.2, gain: 0.28 }, { at: 0.12, dur: 1.3, wave: sine(note(91)), decay: 3, gain: 0.12 }]),
};

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

mkdirSync('public/sounds', { recursive: true });
for (const [name, make] of Object.entries(tones)) {
  const buf = wav(make());
  writeFileSync(`public/sounds/${name}.wav`, buf);
  console.log(`public/sounds/${name}.wav ${(buf.length / 1024).toFixed(0)} KB`);
}
