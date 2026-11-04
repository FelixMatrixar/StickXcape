/**
 * Procedural music (LS-8, LS-9): a fight loop with a final-round layer, and a mellow menu track.
 * A small look-ahead sequencer schedules notes a little ahead of time on the audio clock, so
 * timing stays tight even when the page is busy drawing.
 */
import { audio } from './engine.ts';

export type Track = 'menu' | 'fight';

const LOOKAHEAD = 0.14;
const TICK_MS = 25;

const A = 110;
const note = (semitones: number, base = A) => base * Math.pow(2, semitones / 12);

/** Chord roots (semitones from A) and chord tones, one bar each. */
const FIGHT_BARS: [number, number[]][] = [
  [0, [0, 3, 7]],
  [-4, [-4, 0, 3]],
  [3, [3, 7, 10]],
  [-2, [-2, 2, 5]],
];
const MENU_BARS: [number, number[]][] = [
  [0, [0, 3, 7, 10, 14]],
  [-4, [-4, 0, 3, 7, 11]],
  [3, [3, 7, 10, 14]],
  [-5, [-5, -2, 2, 5, 9]],
];

class Music {
  private track: Track | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextTime = 0;
  /** 1 normal, 2 final round. */
  intensity = 1;
  private rand = 1;

  play(track: Track): void {
    if (this.track === track && this.timer !== null) {
      audio.fadeMusic(1, 0.4);
      return;
    }
    this.track = track;
    this.step = 0;
    this.nextTime = 0;
    this.intensity = 1;
    audio.fadeMusic(1, 0.6);
    if (this.timer === null) this.timer = setInterval(() => this.schedule(), TICK_MS);
  }

  stop(fade = 0.5): void {
    audio.fadeMusic(0, fade);
    const stopping = this.track;
    setTimeout(() => {
      if (this.track === stopping && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
        this.track = null;
      }
    }, fade * 1000 + 50);
  }

  /** The music cuts out on the knockout. */
  cut(): void {
    audio.fadeMusic(0, 0.06);
  }

  resume(): void {
    audio.fadeMusic(1, 0.8);
  }

  private get bpm(): number {
    return this.track === 'fight' ? (this.intensity > 1 ? 146 : 138) : 86;
  }

  private schedule(): void {
    if (!audio.ready || !this.track) return;
    const now = audio.now;
    if (this.nextTime < now) this.nextTime = now + 0.05;
    const stepDur = 60 / this.bpm / 4;
    while (this.nextTime < now + LOOKAHEAD) {
      if (this.track === 'fight') this.fightStep(this.step, this.nextTime, stepDur);
      else this.menuStep(this.step, this.nextTime, stepDur);
      this.step += 1;
      this.nextTime += stepDur;
    }
  }

  private random(): number {
    this.rand = (this.rand * 16807) % 2147483647;
    return (this.rand - 1) / 2147483646;
  }

  // Voices. Times are absolute on the audio clock.

  private at(time: number): number {
    return Math.max(0, time - audio.now);
  }

  private kick(time: number, gain = 0.55): void {
    audio.tone({ type: 'sine', freq: 150, to: 44, dur: 0.2, gain, bus: 'music', delay: this.at(time) });
    audio.noiseBurst({ filter: 'lowpass', freq: 2500, dur: 0.012, gain: gain * 0.25, bus: 'music', delay: this.at(time) });
  }

  private snare(time: number, gain = 0.22): void {
    audio.noiseBurst({ filter: 'bandpass', freq: 1900, q: 0.7, dur: 0.13, gain, bus: 'music', delay: this.at(time) });
    audio.tone({ type: 'triangle', freq: 200, to: 150, dur: 0.07, gain: gain * 0.7, bus: 'music', delay: this.at(time) });
  }

  private hat(time: number, open: boolean, gain = 0.05): void {
    audio.noiseBurst({ filter: 'highpass', freq: 7200, dur: open ? 0.16 : 0.03, gain, bus: 'music', delay: this.at(time) });
  }

  private bass(time: number, freq: number, dur: number, gain = 0.15): void {
    audio.tone({ type: 'sawtooth', freq, dur, gain, bus: 'music', delay: this.at(time), lowpass: 700 });
    audio.tone({ type: 'sine', freq: freq / 2, dur, gain: gain * 0.9, bus: 'music', delay: this.at(time) });
  }

  private stab(time: number, freqs: number[], gain = 0.035): void {
    for (const f of freqs) {
      audio.tone({ type: 'sawtooth', freq: f, dur: 0.16, gain, bus: 'music', delay: this.at(time), lowpass: 2200, detune: -7 });
      audio.tone({ type: 'sawtooth', freq: f, dur: 0.16, gain, bus: 'music', delay: this.at(time), lowpass: 2200, detune: 7 });
    }
  }

  private pluck(time: number, freq: number, gain = 0.05, dur = 0.5): void {
    audio.tone({ type: 'sine', freq, dur, gain, bus: 'music', delay: this.at(time), reverb: 0.3 });
    audio.tone({ type: 'sine', freq: freq * 2, dur: dur * 0.35, gain: gain * 0.35, bus: 'music', delay: this.at(time) });
  }

  private pad(time: number, freqs: number[], dur: number): void {
    for (const f of freqs) audio.tone({ type: 'triangle', freq: f, dur, gain: 0.018, attack: dur * 0.35, bus: 'music', delay: this.at(time), lowpass: 1600, reverb: 0.35 });
  }

  // Patterns: 16 steps a bar.

  private fightStep(step: number, time: number, stepDur: number): void {
    const s = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const [root, chord] = FIGHT_BARS[bar];
    const final = this.intensity > 1;
    if (s % 4 === 0) this.kick(time);
    if (s === 10 && bar % 2 === 1) this.kick(time, 0.4);
    if (s === 4 || s === 12) this.snare(time);
    if (final && s === 15) this.snare(time, 0.12);
    if (final || s % 2 === 0) this.hat(time, s % 4 === 2, s % 4 === 2 ? 0.045 : 0.035);
    const bassSteps = [0, 3, 6, 8, 10, 11, 14];
    if (bassSteps.includes(s)) {
      const octave = s === 6 || s === 14 ? 12 : 0;
      this.bass(time, note(root + octave, 55), stepDur * (s === 8 ? 1.8 : 1.4));
    }
    if (s === 2 || s === 10) this.stab(time, chord.map((n) => note(n, 220)));
    if (final) {
      const arp = chord[s % chord.length] + (s % 8 >= 4 ? 12 : 0);
      audio.tone({ type: 'square', freq: note(arp, 440), dur: stepDur * 0.9, gain: 0.018, bus: 'music', delay: this.at(time), lowpass: 2600 });
      if (s % 4 === 0) audio.noiseBurst({ filter: 'highpass', freq: 9000, dur: 0.25, gain: 0.025, bus: 'music', delay: this.at(time) });
    }
  }

  private menuStep(step: number, time: number, stepDur: number): void {
    const s = step % 16;
    const bar = Math.floor(step / 16) % 4;
    const [root, chord] = MENU_BARS[bar];
    // A lazy swing on the off-beats.
    const swing = s % 2 === 1 ? stepDur * 0.18 : 0;
    const t = time + swing;
    if (s === 0 || s === 10) this.kick(t, 0.32);
    if (s === 7 && bar % 2 === 0) this.kick(t, 0.16);
    if (s === 4 || s === 12) audio.noiseBurst({ filter: 'bandpass', freq: 2400, q: 1.5, dur: 0.06, gain: 0.07, bus: 'music', delay: this.at(t) });
    if (s % 2 === 0) this.hat(t, false, 0.02);
    if (s === 0) {
      this.pad(t, chord.slice(0, 4).map((n) => note(n, 220)), stepDur * 16);
      this.bass(t, note(root, 55), stepDur * 6, 0.07);
    }
    if (s === 8) this.bass(t, note(root + 7, 55), stepDur * 4, 0.05);
    if ((s === 3 || s === 6 || s === 11 || s === 14) && this.random() < 0.6) {
      const n = chord[Math.floor(this.random() * chord.length)];
      this.pluck(t, note(n, 440), 0.035, 0.6);
    }
    // Vinyl crackle.
    if (this.random() < 0.25) audio.noiseBurst({ filter: 'highpass', freq: 3000, dur: 0.008, gain: 0.02 * this.random(), bus: 'music', delay: this.at(t + this.random() * stepDur) });
  }
}

export const music = new Music();
