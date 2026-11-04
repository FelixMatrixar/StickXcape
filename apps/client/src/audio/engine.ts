/**
 * The audio engine: one AudioContext, unlocked by the first tap (browsers block sound before
 * it), with buses for effects, interface and music feeding a compressor. Every sound in the
 * game is synthesized from oscillators and noise, so nothing has to download.
 */
export interface Volumes {
  master: number;
  sfx: number;
  music: number;
}

export interface ToneOptions {
  type?: OscillatorType;
  freq: number;
  /** Glides to this frequency over the sound. */
  to?: number;
  dur: number;
  gain?: number;
  attack?: number;
  /** Seconds after start; defaults to the whole sound. */
  delay?: number;
  pan?: number;
  detune?: number;
  bus?: 'sfx' | 'ui' | 'music';
  reverb?: number;
  /** Through a low-pass filter at this frequency. */
  lowpass?: number;
  distort?: boolean;
}

export interface NoiseOptions {
  filter?: BiquadFilterType;
  freq?: number;
  to?: number;
  q?: number;
  dur: number;
  gain?: number;
  attack?: number;
  delay?: number;
  pan?: number;
  bus?: 'sfx' | 'ui' | 'music';
  reverb?: number;
  distort?: boolean;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private uiBus!: GainNode;
  musicBus!: GainNode;
  private musicFade!: GainNode;
  private musicDuck!: GainNode;
  private reverbIn!: GainNode;
  private noise!: AudioBuffer;
  private shaper!: WaveShaperNode;
  private shaperIn!: GainNode;
  muted = false;
  volumes: Volumes = { master: 0.9, sfx: 1, music: 0.55 };
  private unlockedListeners: (() => void)[] = [];

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  onUnlock(listener: () => void): void {
    if (this.ready) listener();
    else this.unlockedListeners.push(listener);
  }

  /** Call from a tap or key press: creates and resumes the context. */
  unlock(): void {
    try {
      if (!this.ctx) this.build();
      const ctx = this.ctx!;
      if (ctx.state !== 'running') void ctx.resume().then(() => this.flushUnlock());
      // iOS needs a sound started inside the gesture.
      const silent = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = silent;
      src.connect(ctx.destination);
      src.start(0);
      if (ctx.state === 'running') this.flushUnlock();
    } catch {
      // No Web Audio: the game stays silent.
    }
  }

  private flushUnlock(): void {
    for (const listener of this.unlockedListeners.splice(0)) listener();
  }

  private build(): void {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.18;
    this.master = ctx.createGain();
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.uiBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.musicFade = ctx.createGain();
    this.musicDuck = ctx.createGain();
    this.sfxBus.connect(this.master);
    this.uiBus.connect(this.master);
    this.musicBus.connect(this.musicFade);
    this.musicFade.connect(this.musicDuck);
    this.musicDuck.connect(this.master);

    // A short generated room for parries, knockouts and stingers.
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(2.4);
    this.reverbIn = ctx.createGain();
    this.reverbIn.gain.value = 0.9;
    this.reverbIn.connect(reverb);
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    reverb.connect(wet);
    wet.connect(this.master);

    const length = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    this.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 4.5);
    }
    this.shaper.curve = curve;
    this.shaperIn = ctx.createGain();
    this.shaperIn.connect(this.shaper);
    this.shaper.connect(this.sfxBus);
    this.applyVolumes();
  }

  private impulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2);
    }
    return buffer;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyVolumes();
  }

  setVolumes(volumes: Partial<Volumes>): void {
    this.volumes = { ...this.volumes, ...volumes };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.03);
    this.uiBus.gain.setTargetAtTime(this.volumes.sfx * 0.8, t, 0.03);
    this.musicBus.gain.setTargetAtTime(this.volumes.music, t, 0.05);
  }

  /** Fades the music to a level (0 cuts it, as on a knockout) over `seconds`. */
  fadeMusic(level: number, seconds: number): void {
    if (!this.ctx) return;
    const g = this.musicFade.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(level, t + Math.max(0.01, seconds));
  }

  /** Dips the music under a big moment, then brings it back. */
  duck(depth: number, seconds: number): void {
    if (!this.ctx) return;
    const g = this.musicDuck.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(Math.max(0.05, 1 - depth), t + 0.03);
    g.setTargetAtTime(1, t + 0.05 + seconds * 0.3, seconds * 0.5);
  }

  private out(bus: 'sfx' | 'ui' | 'music' | undefined): AudioNode {
    return bus === 'ui' ? this.uiBus : bus === 'music' ? this.musicBus : this.sfxBus;
  }

  private route(node: AudioNode, pan: number | undefined, bus: ToneOptions['bus'], reverb: number | undefined, distort: boolean | undefined): void {
    const ctx = this.ctx!;
    let tail: AudioNode = node;
    if (pan !== undefined && pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      tail.connect(p);
      tail = p;
    }
    tail.connect(distort ? this.shaperIn : this.out(bus));
    if (reverb && reverb > 0) {
      const send = ctx.createGain();
      send.gain.value = reverb;
      tail.connect(send);
      send.connect(this.reverbIn);
    }
  }

  tone(o: ToneOptions): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(1, o.freq), t);
    if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t + o.dur);
    if (o.detune) osc.detune.value = o.detune;
    const env = ctx.createGain();
    const peak = o.gain ?? 0.3;
    const attack = o.attack ?? 0.004;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.01, o.dur));
    osc.connect(env);
    let tail: AudioNode = env;
    if (o.lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.lowpass;
      env.connect(lp);
      tail = lp;
    }
    this.route(tail, o.pan, o.bus, o.reverb, o.distort);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  noiseBurst(o: NoiseOptions): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = o.filter ?? 'bandpass';
    filter.frequency.setValueAtTime(o.freq ?? 1200, t);
    if (o.to !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + o.dur);
    filter.Q.value = o.q ?? 0.9;
    const env = ctx.createGain();
    const peak = o.gain ?? 0.3;
    const attack = o.attack ?? 0.003;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.01, o.dur));
    src.connect(filter);
    filter.connect(env);
    this.route(env, o.pan, o.bus, o.reverb, o.distort);
    const offset = Math.random() * 1.5;
    src.start(t, offset, o.dur + 0.1);
  }
}

export const audio = new AudioEngine();
