#!/usr/bin/env node
/**
 * Deterministic builtin notification sounds for plugins/notification-sounds.
 *
 * Synthesizes 44100 Hz / 16-bit / mono PCM WAVs into
 * plugins/notification-sounds/assets/ and (re)generates assets/index.json.
 * Zero deps, no randomness — rerunning always produces byte-identical files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'notification-sounds', 'assets');

/** Float samples (-1..1) → 16-bit mono WAV Buffer (44-byte canonical header). */
function toWav(samples) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/** Remove DC offset, normalize to the given peak, apply the final fade-out. */
function finish(samples, peak, fadeMs = 10) {
  let mean = 0;
  for (const s of samples) mean += s;
  mean /= samples.length;
  let maxAbs = 0;
  for (let i = 0; i < samples.length; i++) {
    samples[i] -= mean;
    maxAbs = Math.max(maxAbs, Math.abs(samples[i]));
  }
  if (maxAbs > 0) {
    const g = peak / maxAbs;
    for (let i = 0; i < samples.length; i++) samples[i] *= g;
  }
  const fadeN = Math.min(samples.length, Math.round((fadeMs / 1000) * SR));
  for (let i = 0; i < fadeN; i++) {
    samples[samples.length - fadeN + i] *= 1 - i / fadeN;
  }
  return samples;
}

/** Linear sine sweep f0→f1 over sweepSec, exponential decay tau, fade-in ms. */
function sweep(f0, f1, sweepSec, totalSec, tau, fadeInMs) {
  const n = Math.round(totalSec * SR);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = t < sweepSec ? f0 + ((f1 - f0) * t) / sweepSec : f1;
    phase += (2 * Math.PI * f) / SR;
    const fade = Math.min(1, t / (fadeInMs / 1000));
    out[i] = Math.sin(phase) * Math.exp(-t / tau) * fade;
  }
  return out;
}

/** Struck-bell tone: partials with per-partial amplitude, exp decay, attack. */
function bell(freqs, amps, totalSec, tau, attackMs, startSec = 0) {
  const n = Math.round(totalSec * SR);
  const out = new Float64Array(n);
  const startN = Math.round(startSec * SR);
  for (let i = startN; i < n; i++) {
    const t = (i - startN) / SR;
    let v = 0;
    for (let k = 0; k < freqs.length; k++) v += amps[k] * Math.sin(2 * Math.PI * freqs[k] * t);
    const attack = Math.min(1, t / (attackMs / 1000));
    out[i] = v * Math.exp(-t / tau) * attack;
  }
  return out;
}

function add(acc, x) {
  const n = Math.min(acc.length, x.length);
  for (let i = 0; i < n; i++) acc[i] += x[i];
  return acc;
}

const E6 = 1318.51;
const G6 = 1567.98;

// pop: 420→140Hz sweep over ~90ms inside a 140ms envelope, fast decay
const pop = finish(Array.from(sweep(420, 140, 0.09, 0.14, 0.032, 3)), 0.72);
// ding: E6 + 0.4× octave harmonic, τ≈130ms over 600ms
const ding = finish(Array.from(bell([E6, E6 * 2], [1, 0.4], 0.6, 0.13, 1)), 0.7);
// chime: E6 then overlapping G6 (starts 250ms in), 8ms attack, τ≈220ms
const chime = finish(
  Array.from(add(bell([E6, E6 * 2], [1, 0.25], 0.9, 0.22, 8), bell([G6, G6 * 2], [1, 0.25], 0.9, 0.22, 8, 0.25))),
  0.65
);

const sounds = [
  { id: 'builtin:pop', name: '弹跳 Pop', file: 'assets/pop.wav', samples: pop },
  { id: 'builtin:ding', name: '清脆 Ding', file: 'assets/ding.wav', samples: ding },
  { id: 'builtin:chime', name: '柔和风铃 Chime', file: 'assets/chime.wav', samples: chime }
];

fs.mkdirSync(OUT_DIR, { recursive: true });
const index = [];
for (const s of sounds) {
  const wav = toWav(s.samples);
  const file = path.join(OUT_DIR, path.basename(s.file));
  fs.writeFileSync(file, wav);
  index.push({ id: s.id, name: s.name, file: s.file, durationMs: Math.round((s.samples.length / SR) * 1000) });
  console.log(`${s.file}: ${wav.length} bytes, ${index[index.length - 1].durationMs}ms`);
}
fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({ sounds: index }, null, 2) + '\n');
console.log('index.json written');
