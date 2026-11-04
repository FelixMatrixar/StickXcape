/**
 * The sound set: punchy ink-and-paper sounds with no gore (product PRD, Sound plan). Impacts are
 * layered by strength, whooshes follow limb speed, and every impact gets a small random pitch
 * shift so repeated hits never sound identical. Mix: hits first, then stingers, then music.
 */
import type { SceneSound } from '../render/scene.ts';
import { audio } from './engine.ts';

const vary = (amount = 0.06) => 1 + (Math.random() * 2 - 1) * amount;

export const ui = {
  tap(): void {
    const v = vary(0.04);
    audio.tone({ type: 'sine', freq: 1500 * v, to: 820 * v, dur: 0.05, gain: 0.12, bus: 'ui' });
    audio.noiseBurst({ filter: 'highpass', freq: 3500, dur: 0.018, gain: 0.05, bus: 'ui' });
  },
  hover(): void {
    audio.tone({ type: 'sine', freq: 2300 * vary(0.03), dur: 0.03, gain: 0.025, bus: 'ui' });
  },
  /** On-screen fight buttons: a crisp, quiet click so it never masks the hits. */
  press(): void {
    audio.noiseBurst({ filter: 'bandpass', freq: 3200 * vary(0.1), q: 4, dur: 0.014, gain: 0.05, bus: 'ui' });
  },
  confirm(): void {
    audio.tone({ type: 'triangle', freq: 660, dur: 0.12, gain: 0.13, bus: 'ui' });
    audio.tone({ type: 'triangle', freq: 990, dur: 0.22, gain: 0.12, bus: 'ui', delay: 0.06 });
    audio.tone({ type: 'sine', freq: 1980, dur: 0.18, gain: 0.03, bus: 'ui', delay: 0.06 });
  },
  back(): void {
    audio.tone({ type: 'triangle', freq: 560, to: 380, dur: 0.12, gain: 0.1, bus: 'ui' });
  },
  toggle(on: boolean): void {
    audio.tone({ type: 'sine', freq: on ? 700 : 900, to: on ? 1100 : 560, dur: 0.07, gain: 0.1, bus: 'ui' });
  },
  pop(): void {
    const v = vary(0.08);
    audio.tone({ type: 'sine', freq: 950 * v, to: 280 * v, dur: 0.07, gain: 0.14, bus: 'ui' });
  },
  error(): void {
    audio.tone({ type: 'square', freq: 150, to: 120, dur: 0.16, gain: 0.07, bus: 'ui', lowpass: 900 });
    audio.tone({ type: 'square', freq: 150, to: 110, dur: 0.16, gain: 0.07, bus: 'ui', lowpass: 900, delay: 0.12 });
  },
  swoosh(): void {
    audio.noiseBurst({ filter: 'bandpass', freq: 380, to: 2600, q: 1.4, dur: 0.32, gain: 0.16, attack: 0.08, bus: 'ui' });
  },
  stamp(): void {
    audio.tone({ type: 'sine', freq: 180, to: 70, dur: 0.12, gain: 0.25, bus: 'ui' });
    audio.noiseBurst({ filter: 'lowpass', freq: 1400, dur: 0.06, gain: 0.12, bus: 'ui' });
  },
  countdown(n: number): void {
    const freq = n > 0 ? 880 : 1320;
    audio.tone({ type: 'square', freq, dur: n > 0 ? 0.14 : 0.42, gain: 0.07, bus: 'ui', lowpass: 3200 });
    audio.tone({ type: 'sine', freq: freq * 2, dur: n > 0 ? 0.1 : 0.3, gain: 0.04, bus: 'ui' });
  },
  record(on: boolean): void {
    const notes = on ? [523, 659, 784] : [784, 659, 523];
    notes.forEach((f, i) => audio.tone({ type: 'triangle', freq: f, dur: 0.14, gain: 0.1, bus: 'ui', delay: i * 0.06 }));
  },
  shutter(): void {
    audio.noiseBurst({ filter: 'highpass', freq: 2200, dur: 0.04, gain: 0.18, bus: 'ui' });
    audio.noiseBurst({ filter: 'bandpass', freq: 900, dur: 0.06, gain: 0.12, bus: 'ui', delay: 0.05 });
  },
  type(): void {
    audio.noiseBurst({ filter: 'bandpass', freq: 2600 * vary(0.2), q: 3, dur: 0.012, gain: 0.04, bus: 'ui' });
  },
  sparkle(): void {
    [1320, 1760, 2349, 2637].forEach((f, i) => audio.tone({ type: 'sine', freq: f, dur: 0.25, gain: 0.045, bus: 'ui', delay: i * 0.045, reverb: 0.4 }));
  },
};

/** Fight sounds, wired to the scene's motion and hit events. */
export const fightSound: SceneSound = {
  whoosh(speed, pan) {
    const s = Math.min(1, (speed - 4) / 9);
    const v = vary(0.08);
    audio.noiseBurst({ filter: 'bandpass', freq: (500 + s * 700) * v, to: (1700 + s * 2600) * v, q: 1.3, dur: 0.11 + s * 0.08, gain: 0.08 + s * 0.12, attack: 0.03, pan });
    audio.noiseBurst({ filter: 'bandpass', freq: 2600 * v, to: 900 * v, q: 2, dur: 0.1 + s * 0.06, gain: 0.03 + s * 0.04, attack: 0.04, pan, delay: 0.05 });
  },
  footstep(intensity, pan) {
    audio.noiseBurst({ filter: 'lowpass', freq: 700 * vary(0.15), dur: 0.05, gain: 0.05 + intensity * 0.08, pan });
    audio.tone({ type: 'sine', freq: 95 * vary(0.1), to: 55, dur: 0.06, gain: 0.04 + intensity * 0.08, pan });
  },
  land(intensity, pan) {
    audio.tone({ type: 'sine', freq: 110 * vary(), to: 42, dur: 0.14 + intensity * 0.06, gain: 0.18 + intensity * 0.2, pan });
    audio.noiseBurst({ filter: 'lowpass', freq: 900, to: 200, dur: 0.12, gain: 0.08 + intensity * 0.12, pan });
  },
  hit(strength, counter, pan) {
    const v = vary();
    if (strength === 0) {
      // A light thud: paper slap over a short body hit.
      audio.tone({ type: 'sine', freq: 190 * v, to: 72 * v, dur: 0.09, gain: 0.42, pan });
      audio.noiseBurst({ filter: 'bandpass', freq: 2100 * v, q: 1.2, dur: 0.03, gain: 0.3, pan });
      audio.noiseBurst({ filter: 'highpass', freq: 4200, dur: 0.045, gain: 0.08, pan, delay: 0.005 });
    } else if (strength === 1) {
      audio.tone({ type: 'sine', freq: 150 * v, to: 52 * v, dur: 0.15, gain: 0.55, pan });
      audio.noiseBurst({ filter: 'bandpass', freq: 1300 * v, q: 1.1, dur: 0.07, gain: 0.34, pan, distort: true });
      audio.noiseBurst({ filter: 'highpass', freq: 3600, dur: 0.06, gain: 0.1, pan });
      audio.duck(0.25, 0.25);
    } else {
      // A layered crunch: sub thump, distorted crack, high snap, and an air tail.
      audio.tone({ type: 'sine', freq: 120 * v, to: 36 * v, dur: 0.32, gain: 0.85, pan });
      audio.tone({ type: 'triangle', freq: 70 * v, to: 30, dur: 0.24, gain: 0.3, pan, distort: true });
      audio.noiseBurst({ filter: 'bandpass', freq: 950 * v, q: 0.9, dur: 0.14, gain: 0.5, pan, distort: true, reverb: 0.25 });
      audio.noiseBurst({ filter: 'highpass', freq: 3000, dur: 0.08, gain: 0.16, pan });
      audio.noiseBurst({ filter: 'bandpass', freq: 1800, to: 500, q: 1.2, dur: 0.3, gain: 0.08, pan, delay: 0.04, attack: 0.04 });
      audio.duck(0.5, 0.45);
    }
    if (counter) {
      audio.tone({ type: 'triangle', freq: 1760 * v, dur: 0.16, gain: 0.08, pan, reverb: 0.3 });
      audio.tone({ type: 'sine', freq: 2640 * v, dur: 0.12, gain: 0.05, pan, delay: 0.03 });
    }
  },
  block(strength, pan) {
    const v = vary();
    audio.noiseBurst({ filter: 'lowpass', freq: 520 * v, dur: 0.09 + strength * 0.03, gain: 0.3 + strength * 0.08, pan });
    audio.tone({ type: 'sine', freq: 230 * v, to: 150, dur: 0.07, gain: 0.22, pan });
    audio.tone({ type: 'square', freq: 330 * v, dur: 0.035, gain: 0.04, pan, lowpass: 1200 });
  },
  parry(pan) {
    // A sharp metallic clang: inharmonic partials ringing out, plus a rising shing.
    const base = 820 * vary(0.03);
    const partials: [number, number, number][] = [
      [1, 0.22, 1.1],
      [2.76, 0.12, 0.8],
      [5.4, 0.07, 0.55],
      [8.93, 0.04, 0.35],
    ];
    for (const [ratio, gain, dur] of partials) audio.tone({ type: 'sine', freq: base * ratio, dur, gain, pan, reverb: 0.55 });
    audio.noiseBurst({ filter: 'highpass', freq: 2500, dur: 0.04, gain: 0.3, pan });
    audio.noiseBurst({ filter: 'bandpass', freq: 3000, to: 9000, q: 2.5, dur: 0.22, gain: 0.09, pan, attack: 0.02, delay: 0.02 });
    audio.duck(0.4, 0.5);
  },
  armor(pan) {
    const v = vary(0.04);
    audio.tone({ type: 'triangle', freq: 2200 * v, dur: 0.12, gain: 0.09, pan });
    audio.tone({ type: 'triangle', freq: 3300 * v, dur: 0.09, gain: 0.06, pan });
    audio.noiseBurst({ filter: 'highpass', freq: 5000, dur: 0.03, gain: 0.12, pan });
  },
  whiff(pan) {
    audio.noiseBurst({ filter: 'bandpass', freq: 900, to: 400, q: 0.8, dur: 0.16, gain: 0.05, attack: 0.04, pan });
  },
  jump(pan) {
    audio.noiseBurst({ filter: 'bandpass', freq: 600, to: 1900, q: 1.2, dur: 0.13, gain: 0.08, attack: 0.02, pan });
    audio.tone({ type: 'sine', freq: 140, to: 90, dur: 0.06, gain: 0.08, pan });
  },
  dash(pan) {
    audio.noiseBurst({ filter: 'bandpass', freq: 1400, to: 500, q: 1, dur: 0.16, gain: 0.12, attack: 0.01, pan });
    audio.tone({ type: 'sine', freq: 100, to: 60, dur: 0.06, gain: 0.08, pan });
  },
  knockdown(pan) {
    audio.tone({ type: 'sine', freq: 90, to: 34, dur: 0.3, gain: 0.55, pan });
    audio.noiseBurst({ filter: 'lowpass', freq: 800, to: 160, dur: 0.3, gain: 0.25, pan });
  },
  body(intensity, pan) {
    audio.tone({ type: 'sine', freq: 85 * vary(0.12), to: 38, dur: 0.12 + intensity * 0.1, gain: 0.15 + intensity * 0.35, pan });
    audio.noiseBurst({ filter: 'lowpass', freq: 600, dur: 0.1, gain: 0.06 + intensity * 0.12, pan });
  },
  grab(pan) {
    // A cloth snap as the hands close.
    audio.noiseBurst({ filter: 'bandpass', freq: 1800 * vary(0.1), q: 2.2, dur: 0.045, gain: 0.32, pan });
    audio.tone({ type: 'sine', freq: 130 * vary(), to: 70, dur: 0.07, gain: 0.3, pan });
  },
  slam(pan) {
    // A body slam: deep thump, crack and a rumble of dust.
    audio.tone({ type: 'sine', freq: 96 * vary(), to: 30, dur: 0.42, gain: 0.95, pan });
    audio.noiseBurst({ filter: 'bandpass', freq: 700 * vary(), q: 0.9, dur: 0.16, gain: 0.45, pan, distort: true });
    audio.noiseBurst({ filter: 'lowpass', freq: 900, to: 140, dur: 0.48, gain: 0.32, pan, reverb: 0.3 });
    audio.duck(0.5, 0.5);
  },
  clash(pan) {
    audio.tone({ type: 'triangle', freq: 1400 * vary(0.04), dur: 0.09, gain: 0.1, pan });
    audio.tone({ type: 'triangle', freq: 2100 * vary(0.04), dur: 0.07, gain: 0.07, pan, delay: 0.04 });
    audio.noiseBurst({ filter: 'highpass', freq: 4000, dur: 0.03, gain: 0.12, pan });
  },
  guardBreak(pan) {
    // Glass giving way: a bright crash, falling pings and a thud.
    audio.noiseBurst({ filter: 'highpass', freq: 3500, dur: 0.28, gain: 0.32, pan, reverb: 0.4 });
    audio.noiseBurst({ filter: 'bandpass', freq: 5200, to: 1800, q: 3, dur: 0.35, gain: 0.12, pan, delay: 0.03 });
    [2600, 2050, 1560].forEach((f, i) => audio.tone({ type: 'sine', freq: f * vary(0.03), to: f * 0.55, dur: 0.22, gain: 0.07, pan, delay: 0.04 + i * 0.06, reverb: 0.4 }));
    audio.tone({ type: 'sine', freq: 140, to: 60, dur: 0.2, gain: 0.45, pan });
    audio.duck(0.4, 0.4);
  },
  tired(pan) {
    // Out of breath: two short exhales.
    audio.noiseBurst({ filter: 'lowpass', freq: 650, to: 300, dur: 0.26, gain: 0.07, attack: 0.07, pan });
    audio.noiseBurst({ filter: 'lowpass', freq: 600, to: 280, dur: 0.24, gain: 0.06, attack: 0.07, pan, delay: 0.3 });
  },
  roll(pan) {
    audio.noiseBurst({ filter: 'lowpass', freq: 520, dur: 0.26, gain: 0.12, attack: 0.03, pan });
    audio.tone({ type: 'sine', freq: 90, to: 50, dur: 0.07, gain: 0.12, pan, delay: 0.08 });
    audio.tone({ type: 'sine', freq: 80, to: 45, dur: 0.07, gain: 0.1, pan, delay: 0.22 });
  },
  fall() {
    // A long falling whoosh, wind, and a far-off landing.
    audio.noiseBurst({ filter: 'bandpass', freq: 1600, to: 240, q: 1.1, dur: 1.5, gain: 0.22, attack: 0.15 });
    audio.noiseBurst({ filter: 'highpass', freq: 2400, dur: 1.6, gain: 0.05, attack: 0.3 });
    audio.tone({ type: 'sine', freq: 70, to: 36, dur: 0.5, gain: 0.22, delay: 1.25, reverb: 0.6 });
  },
  ko() {
    // Boom, then the music drops out (the fight screen cuts it).
    audio.tone({ type: 'sine', freq: 72, to: 26, dur: 1.6, gain: 1, reverb: 0.4 });
    audio.tone({ type: 'triangle', freq: 48, to: 24, dur: 1.1, gain: 0.35, distort: true });
    audio.noiseBurst({ filter: 'lowpass', freq: 420, to: 60, dur: 1.4, gain: 0.5, reverb: 0.6 });
    audio.noiseBurst({ filter: 'bandpass', freq: 1100, q: 0.8, dur: 0.18, gain: 0.55, distort: true });
    audio.tone({ type: 'sine', freq: 1240, to: 1180, dur: 2.2, gain: 0.025, attack: 0.3, delay: 0.25 });
  },
};

/** Announcer stingers for the text pop-ups (ROUND 1, FIGHT, KO). */
export const stinger = {
  round(round: number): void {
    const root = 220 * Math.pow(2, (round - 1) / 12);
    [1, 1.26, 1.5].forEach((ratio) => {
      audio.tone({ type: 'sawtooth', freq: root * ratio, dur: 0.5, gain: 0.07, lowpass: 1800, detune: -8, reverb: 0.4 });
      audio.tone({ type: 'sawtooth', freq: root * ratio, dur: 0.5, gain: 0.07, lowpass: 1800, detune: 8 });
    });
    audio.tone({ type: 'sine', freq: 90, to: 45, dur: 0.4, gain: 0.5 });
    audio.noiseBurst({ filter: 'lowpass', freq: 300, dur: 0.35, gain: 0.25 });
  },
  fight(): void {
    [1, 1.335, 1.5, 2].forEach((ratio, i) => {
      audio.tone({ type: 'sawtooth', freq: 293.7 * ratio, dur: 0.7, gain: 0.07, lowpass: 2600, detune: (i % 2 ? 1 : -1) * 9, reverb: 0.5 });
    });
    audio.tone({ type: 'sine', freq: 110, to: 38, dur: 0.6, gain: 0.8 });
    audio.noiseBurst({ filter: 'highpass', freq: 5000, dur: 1.2, gain: 0.12, attack: 0.005, reverb: 0.4 });
    audio.noiseBurst({ filter: 'bandpass', freq: 900, dur: 0.15, gain: 0.35, distort: true });
  },
  ko(): void {
    [1, 1.19, 1.5].forEach((ratio) => audio.tone({ type: 'sawtooth', freq: 110 * ratio, dur: 1.4, gain: 0.08, lowpass: 900, reverb: 0.7, attack: 0.01 }));
  },
  timeUp(): void {
    audio.tone({ type: 'sine', freq: 1568, to: 1200, dur: 0.5, gain: 0.12 });
    audio.tone({ type: 'sine', freq: 1568, to: 1200, dur: 0.5, gain: 0.12, delay: 0.25 });
  },
  tick(seconds: number): void {
    const high = seconds <= 3;
    audio.noiseBurst({ filter: 'bandpass', freq: high ? 2600 : 1800, q: 6, dur: 0.035, gain: high ? 0.22 : 0.14 });
    audio.tone({ type: 'sine', freq: high ? 1400 : 1000, dur: 0.05, gain: high ? 0.06 : 0.035 });
  },
  victory(): void {
    [523.3, 659.3, 784, 1046.5, 1318.5].forEach((f, i) => {
      audio.tone({ type: 'triangle', freq: f, dur: 0.5, gain: 0.08, delay: i * 0.09, reverb: 0.5 });
      audio.tone({ type: 'sine', freq: f * 2, dur: 0.35, gain: 0.025, delay: i * 0.09 });
    });
    audio.noiseBurst({ filter: 'highpass', freq: 6000, dur: 1.5, gain: 0.08, delay: 0.4, attack: 0.3, reverb: 0.4 });
  },
  defeat(): void {
    [392, 349.2, 311.1, 261.6].forEach((f, i) => audio.tone({ type: 'triangle', freq: f, dur: 0.5, gain: 0.07, delay: i * 0.16, lowpass: 1500 }));
  },
};
