/**
 * The fight scene: draws the simulation and turns its events into game feel (GF-1 to GF-3,
 * LS-7). Most of what players see and hear comes from motion: limb speed drives trails, smears
 * and whooshes, foot plants drive footsteps and dust, and the contact point places the spark.
 * Everything here is cosmetic; the simulation never reads it.
 */
import { fromFixed } from '@sticxcape/shared';
import { PHASE, S, type FightSim, type Fighter, type SimEvent } from '../engine/sim.ts';
import { sampleMove, type CompiledMove } from '../engine/moves.ts';
import { blendPose, createPose, J, JOINT_COUNT, POSE_SIZE } from '../engine/skeleton.ts';
import { paperGrain, type ArenaArt } from './arenas.ts';
import { FightCamera } from './camera.ts';
import { rgba, type Ink } from './inks.ts';
import { FX } from './palette.ts';
import { dust, inkSpray, K, Particles, sparks } from './particles.ts';
import { POP, Popups } from './popups.ts';
import { jointsBetween } from './pose.ts';
import { Ragdoll } from './ragdoll.ts';
import { drawFigure } from './stickman.ts';

export interface SceneSound {
  whoosh(speed: number, pan: number): void;
  footstep(intensity: number, pan: number): void;
  land(intensity: number, pan: number): void;
  hit(strength: number, counter: boolean, pan: number): void;
  block(strength: number, pan: number): void;
  parry(pan: number): void;
  armor(pan: number): void;
  whiff(pan: number): void;
  jump(pan: number): void;
  dash(pan: number): void;
  knockdown(pan: number): void;
  body(intensity: number, pan: number): void;
  ko(): void;
  grab(pan: number): void;
  slam(pan: number): void;
  clash(pan: number): void;
  guardBreak(pan: number): void;
  tired(pan: number): void;
  roll(pan: number): void;
  fall(): void;
}

export type HapticKind = 'light' | 'heavy' | 'parry' | 'block' | 'ko';

export interface SceneOptions {
  canvas: HTMLCanvasElement;
  sim: FightSim;
  arena: ArenaArt;
  inks: [Ink, Ink];
  /** The fighter you control, for "you" cues; null when watching (title screen). */
  localSide: 0 | 1 | null;
  sound?: SceneSound | null;
  haptic?: ((kind: HapticKind) => void) | null;
  /** Comfort settings (GF-5): 0..1 for shake and flashes. */
  shake?: number;
  flashes?: number;
  damageNumbers?: boolean;
  /** Fewer layers for the title screen's background fight. */
  quiet?: boolean;
  /** Recorded idle stances (LS-12), drawn in place of the stance: looks only, hurtboxes don't change. */
  idles?: [CompiledMove | null, CompiledMove | null];
  onEvent?: (event: SimEvent) => void;
}

/** Limb tips tracked for trails, smears and whooshes. */
const TIPS = [J.lWrist, J.rWrist, J.lToe, J.rToe, J.lKnee, J.rKnee] as const;
const TIP_PARENT = [J.lElbow, J.rElbow, J.lAnkle, J.rAnkle, J.lHip, J.rHip] as const;
const TRAIL_POINTS = 12;
const TRAIL_SECONDS = 0.13;
const WHOOSH_SPEED = 5.2;
const SMEAR_SPEED = 7;
/** Seconds to blend from an active ragdoll back to the fighter's pose. */
const RELEASE = 0.16;

interface Trail {
  x: Float32Array;
  y: Float32Array;
  t: Float32Array;
  head: number;
  count: number;
}

class View {
  readonly prev = new Int32Array(POSE_SIZE);
  readonly curr = new Int32Array(POSE_SIZE);
  px = 0;
  py = 0;
  cx = 0;
  cy = 0;
  facing = 1;
  readonly local = new Float32Array(JOINT_COUNT * 2);
  readonly world = new Float32Array(JOINT_COUNT * 2);
  readonly screen = new Float32Array(JOINT_COUNT * 2);
  /** Joint positions at the last two simulation frames, metres. */
  readonly stepPrev = new Float32Array(JOINT_COUNT * 2);
  readonly stepCurr = new Float32Array(JOINT_COUNT * 2);
  readonly tipSpeed = new Float32Array(TIPS.length);
  readonly whooshCool = new Float32Array(TIPS.length);
  readonly trails: Trail[] = TIPS.map(() => ({ x: new Float32Array(TRAIL_POINTS), y: new Float32Array(TRAIL_POINTS), t: new Float32Array(TRAIL_POINTS), head: 0, count: 0 }));
  squash = 0;
  squashVel = 0;
  squashAngle = 0;
  flash = 0;
  limbFlash = 0;
  limbJoint = -1;
  jitter = 0;
  readonly footY = new Float32Array([0, 0]);
  ragdoll: Ragdoll | null = null;
  /** Seconds left blending out of an active ragdoll, or 0. */
  release = 0;
  /** Where the simulation has the joints this frame, metres: what an active ragdoll reaches for. */
  readonly target = new Float32Array(JOINT_COUNT * 2);
  ready = false;
  /** How much of the recorded idle stance shows, 0..1. */
  idleW = 0;
}

export class FightScene {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly camera = new FightCamera();
  readonly particles = new Particles();
  readonly popups = new Popups();
  sim: FightSim;
  arena: ArenaArt;
  inks: [Ink, Ink];
  localSide: 0 | 1 | null;
  sound: SceneSound | null;
  haptic: ((kind: HapticKind) => void) | null;
  shake: number;
  flashes: number;
  damageNumbers: boolean;
  onEvent: ((event: SimEvent) => void) | null;
  private readonly quiet: boolean;
  private readonly views: [View, View] = [new View(), new View()];
  private dpr = 1;
  private time = 0;
  private timeScale = 1;
  private freeze = 0;
  private slowmo = 0;
  private flashAlpha = 0;
  private invert = 0;
  private koDim = 0;
  private vignette: HTMLCanvasElement | null = null;
  private lastFrameMs = 16;
  /** The arena's ledges in metres (AR-6). */
  private ledges: { x0: number; x1: number; top: number }[] = [];
  private stepClock = 0;
  idles: [CompiledMove | null, CompiledMove | null];
  private readonly mixA = createPose();
  private readonly mixB = createPose();
  private readonly mixIdle = createPose();

  constructor(options: SceneOptions) {
    this.canvas = options.canvas;
    this.ctx = options.canvas.getContext('2d', { alpha: false })!;
    this.sim = options.sim;
    this.arena = options.arena;
    this.inks = options.inks;
    this.localSide = options.localSide;
    this.sound = options.sound ?? null;
    this.haptic = options.haptic ?? null;
    this.shake = options.shake ?? 1;
    this.flashes = options.flashes ?? 1;
    this.damageNumbers = options.damageNumbers ?? false;
    this.quiet = options.quiet ?? false;
    this.onEvent = options.onEvent ?? null;
    this.idles = options.idles ?? [null, null];
    this.camera.arenaWidth = fromFixed(this.sim.arenaWidth);
    this.camera.edgeMargin = this.sim.dropLeft || this.sim.dropRight ? 1.7 : 0.6;
    this.ledges = ledgesInMetres(this.sim);
    this.resize();
    this.syncViews(true);
  }

  /** Swaps in a new simulation (rematch) without rebuilding the scene. */
  setSim(sim: FightSim): void {
    this.sim = sim;
    this.camera.edgeMargin = sim.dropLeft || sim.dropRight ? 1.7 : 0.6;
    this.ledges = ledgesInMetres(sim);
    this.particles.clear();
    this.popups.clear();
    for (const view of this.views) {
      view.ragdoll = null;
      view.ready = false;
    }
    this.syncViews(true);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    // Cap the pixel ratio: phones gain little above 2 and pay for every pixel.
    this.dpr = Math.min(window.devicePixelRatio || 1, this.lastFrameMs > 22 ? 1.25 : 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.camera.resize(width, height);
    this.vignette = null;
  }

  // Simulation frames.

  /** Call after every sim.step(). */
  onStep(): void {
    this.stepClock = 0;
    this.syncViews(false);
    for (const event of this.sim.events) this.handle(event);
    this.motionEffects();
  }

  private syncViews(snap: boolean): void {
    for (const f of this.sim.fighters) {
      const view = this.views[f.side];
      if (snap || !view.ready) {
        view.prev.set(f.pose);
        view.curr.set(f.pose);
        view.px = view.cx = fromFixed(f.x);
        view.py = view.cy = fromFixed(f.y);
        for (let i = 0; i < JOINT_COUNT * 2; i++) view.stepPrev[i] = view.stepCurr[i] = fromFixed(f.world[i]);
        view.ready = true;
      } else {
        view.prev.set(view.curr);
        view.curr.set(f.pose);
        view.px = view.cx;
        view.py = view.cy;
        view.cx = fromFixed(f.x);
        view.cy = fromFixed(f.y);
        view.stepPrev.set(view.stepCurr);
        for (let i = 0; i < JOINT_COUNT * 2; i++) view.stepCurr[i] = fromFixed(f.world[i]);
      }
      if (view.facing !== f.facing) {
        // A turn: no interpolation across the mirror flip.
        view.prev.set(f.pose);
        view.px = view.cx;
      }
      view.facing = f.facing;
    }
    if (snap) this.camera.update(0, this.targets(), true);
  }

  private pan(x: number): number {
    return Math.max(-0.85, Math.min(0.85, (this.camera.sx(x) / this.camera.width) * 2 - 1));
  }

  /** The height of the floor or ledge top under x, for a point at height y (metres). */
  private groundAt(x: number, y: number): number {
    let ground = 0;
    for (const ledge of this.ledges) {
      if (x >= ledge.x0 && x <= ledge.x1 && ledge.top <= y + 0.05 && ledge.top > ground) ground = ledge.top;
    }
    return ground;
  }

  /** Footsteps from foot plants, whooshes from limb speed. */
  private motionEffects(): void {
    for (const f of this.sim.fighters) {
      const view = this.views[f.side];
      if (view.ragdoll) continue;
      const lying = f.state === S.knockdown || f.state === S.ko || f.state === S.launched || f.state === S.roll || f.state === S.thrown || f.falling === 1;
      // Feet.
      for (let foot = 0; foot < 2; foot++) {
        const ankle = foot === 0 ? J.lAnkle : J.rAnkle;
        const toe = foot === 0 ? J.lToe : J.rToe;
        const floor = fromFixed(f.floor);
        const y = Math.min(view.stepCurr[2 * ankle + 1], view.stepCurr[2 * toe + 1]) - floor;
        const before = view.footY[foot];
        view.footY[foot] = y;
        if (!lying && before > 0.035 && y <= 0.016) {
          const drop = Math.min(1, (before - y) * 18);
          const x = view.stepCurr[2 * toe];
          if (!this.quiet) dust(this.particles, x, 2 + Math.round(drop * 4), 0.4, 0.4 + drop, floor);
          this.sound?.footstep(0.3 + drop * 0.7, this.pan(x));
        }
      }
      // Limb speed.
      for (let i = 0; i < TIPS.length; i++) {
        const tip = TIPS[i];
        const dx = view.stepCurr[2 * tip] - view.stepPrev[2 * tip] - (view.cx - view.px);
        const dy = view.stepCurr[2 * tip + 1] - view.stepPrev[2 * tip + 1] - (view.cy - view.py);
        const speed = Math.hypot(dx, dy) * 60;
        const before = view.tipSpeed[i];
        view.tipSpeed[i] = speed;
        if (speed > WHOOSH_SPEED && before <= WHOOSH_SPEED && view.whooshCool[i] <= 0 && (f.state === S.attack || f.state === S.throw || f.state === S.grab)) {
          view.whooshCool[i] = 0.22;
          this.sound?.whoosh(speed, this.pan(view.stepCurr[2 * tip]));
        }
      }
    }
  }

  private handle(event: SimEvent): void {
    this.onEvent?.(event);
    const ps = this.particles;
    switch (event.type) {
      case 'round':
        ps.clearDecals();
        this.popups.clear();
        for (const view of this.views) {
          view.ragdoll = null;
          view.release = 0;
        }
        this.camera.edgeMargin = this.sim.dropLeft || this.sim.dropRight ? 1.7 : 0.6;
        this.syncViews(true);
        this.timeScale = 1;
        this.slowmo = 0;
        this.koDim = 0;
        return;
      case 'hit': {
        const x = fromFixed(event.x);
        const y = fromFixed(event.y);
        const dx = fromFixed(event.dirX);
        const dy = fromFixed(event.dirY);
        const attacker = this.inks[event.side];
        const target = this.views[event.target];
        const pan = this.pan(x);
        const s = event.glancing ? Math.max(0, event.strength - 1) : event.strength;
        target.limbJoint = event.hurtJoint;
        target.limbFlash = 1;
        target.jitter = 1;
        target.squash = 0;
        target.squashVel = 3 + s * 2.2;
        target.squashAngle = Math.atan2(dy, dx);
        if (s >= 2) target.flash = 0.9;
        // The ink spark, scaled by strength.
        ps.spawn(K.burst, x, y, { size: 0.04, size2: 0.16 + s * 0.12, life: 0.16 + s * 0.05, color: '#ffffff', rot: Math.random() * 3 });
        ps.spawn(K.burst, x, y, { size: 0.03, size2: 0.12 + s * 0.11, life: 0.2 + s * 0.06, color: attacker.ink, rot: Math.random() * 3, alpha: 0.9 });
        inkSpray(ps, x, y, dx, dy, 5 + s * 9, 3 + s * 2.5, attacker.ink, 0.02 + s * 0.006);
        sparks(ps, x, y, 4 + s * 5, 7 + s * 3, s >= 2 ? FX.hitSpark : '#ffffff', dx, dy, 1.6);
        if (s >= 1) ps.spawn(K.ring, x, y, { size: 0.05, size2: 0.32 + s * 0.12, life: 0.24, color: '#ffffff', alpha: 0.85 });
        if (s >= 2) {
          for (let i = 0; i < 10; i++) {
            const a = Math.random() * Math.PI * 2;
            const v = 7 + Math.random() * 5;
            ps.spawn(K.streak, x + Math.cos(a) * 0.12, y + Math.sin(a) * 0.12, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.16, size: 0.012, size2: 0.35, color: 'rgba(255,255,255,0.9)', drag: 4 });
          }
          this.flashAlpha = Math.max(this.flashAlpha, 0.28 * this.flashes);
          this.camera.zoomPunch(0.08);
        }
        if (event.counter) {
          ps.spawn(K.ring, x, y, { size: 0.08, size2: 0.6, life: 0.32, color: FX.counterRing, alpha: 0.9 });
          this.popups.show('COUNTER', x, y + 0.42, POP.counter);
        }
        if (event.combo >= 2) {
          this.popups.show(`${event.combo}`, fromFixed(this.sim.fighters[event.side].x), 2.3, { fill: attacker.ink, stroke: '#ffffff', size: 0.36, sub: 'HITS', life: 1.1, rise: 0.05 }, `combo${event.side}`);
        }
        if (this.damageNumbers) this.popups.show(`${(event.damage / 10).toFixed(event.damage % 10 ? 1 : 0)}`, x + 0.1, y + 0.18, POP.damage);
        if (event.launch) {
          const t = this.sim.fighters[event.target];
          const tx = fromFixed(t.x);
          dust(ps, tx, 6, 0.5, 1.2, this.groundAt(tx, fromFixed(t.y)));
        }
        // CB-8: a launch hands the body to an active ragdoll that flails along the blow.
        if (!event.ko && (event.launch || this.views[event.target].ragdoll?.active)) {
          const ragdoll = this.activeRagdoll(event.target as 0 | 1);
          const kick = 2.5 + s * 2.2;
          ragdoll.kick(event.hurtJoint, dx * kick, dy * kick + 0.8);
        }
        this.camera.addTrauma(0.14 + s * 0.13 + (event.counter ? 0.1 : 0));
        this.sound?.hit(s, event.counter, pan);
        this.haptic?.(s >= 2 ? 'heavy' : 'light');
        return;
      }
      case 'block': {
        const x = fromFixed(event.x);
        const y = fromFixed(event.y);
        const blocker = this.sim.fighters[event.target];
        const facing = blocker.facing;
        ps.spawn(K.arc, x - facing * 0.06, y, { size: 0.16, size2: 0.32 + event.strength * 0.05, life: 0.3, rot: facing > 0 ? 0 : Math.PI, color: FX.blockArc, alpha: 0.95 });
        sparks(ps, x, y, 5 + event.strength * 3, 5, FX.blockSpark, -facing, 0.3, 1.8);
        this.popups.show('BLOCKED', x, y + 0.36, POP.blocked);
        this.views[event.target].squashVel = 1.5 + event.strength;
        this.views[event.target].squashAngle = facing > 0 ? Math.PI : 0;
        this.camera.addTrauma(0.06 + event.strength * 0.05);
        this.sound?.block(event.strength, this.pan(x));
        this.haptic?.('block');
        return;
      }
      case 'parry': {
        const x = fromFixed(event.x);
        const y = fromFixed(event.y);
        ps.spawn(K.ring, x, y, { size: 0.06, size2: 0.9, life: 0.42, color: FX.parryRing, alpha: 1 });
        ps.spawn(K.ring, x, y, { size: 0.04, size2: 0.5, life: 0.3, color: '#ffffff', alpha: 1 });
        ps.spawn(K.star, x, y, { size: 0.08, size2: 0.55, life: 0.26, color: '#ffffff', rot: Math.PI / 4 });
        sparks(ps, x, y, 16, 9, FX.parrySpark);
        this.popups.show('PARRY!', x, y + 0.5, POP.parry);
        this.flashAlpha = Math.max(this.flashAlpha, 0.22 * this.flashes);
        const parrier = this.sim.fighters[event.side];
        this.camera.focus(fromFixed(parrier.x), 1.2, 0.45, 0.45, 0.16);
        this.camera.addTrauma(0.2);
        this.views[event.target].squashVel = 4;
        this.views[event.target].squashAngle = parrier.facing > 0 ? 0 : Math.PI;
        this.sound?.parry(this.pan(x));
        this.haptic?.('parry');
        return;
      }
      case 'armor': {
        const x = fromFixed(event.x);
        const y = fromFixed(event.y);
        sparks(ps, x, y, 8, 6, FX.armorSpark);
        ps.spawn(K.ring, x, y, { size: 0.04, size2: 0.3, life: 0.2, color: FX.armorRing });
        this.popups.show('ARMOR', x, y + 0.36, POP.armor);
        this.views[event.side].flash = 0.6;
        this.sound?.armor(this.pan(x));
        this.haptic?.('light');
        return;
      }
      case 'whiff':
        if (event.near && !this.quiet) {
          const f = this.sim.fighters[event.side];
          this.popups.show('WHIFF', fromFixed(f.x) + f.facing * 0.5, 1.9, POP.whiff);
          this.sound?.whiff(this.pan(fromFixed(f.x)));
        }
        return;
      case 'jump': {
        const x = fromFixed(event.x);
        dust(ps, x, 4, 0.3, 0.8, fromFixed(event.y));
        this.sound?.jump(this.pan(x));
        return;
      }
      case 'land': {
        const x = fromFixed(event.x);
        const y = fromFixed(event.y);
        dust(ps, x, event.hard ? 10 : 5, 0.5, event.hard ? 1.6 : 0.9, y);
        if (event.hard) ps.spawn(K.ring, x, y + 0.02, { size: 0.1, size2: 0.6, life: 0.3, color: 'rgba(120,105,90,0.5)' });
        this.sound?.land(event.hard ? 1 : 0.5, this.pan(x));
        return;
      }
      case 'dash': {
        const x = fromFixed(event.x);
        const f = this.sim.fighters[event.side];
        for (let i = 0; i < 6; i++) {
          ps.spawn(K.puff, x - f.facing * event.dir * 0.1, fromFixed(event.y) + 0.05, { vx: -f.facing * event.dir * (1 + Math.random() * 2), vy: 0.2 + Math.random() * 0.3, life: 0.4, size: 0.04, size2: 0.14, color: 'rgba(120,105,90,0.5)', drag: 4 });
        }
        this.sound?.dash(this.pan(x));
        return;
      }
      case 'knockdown': {
        const x = fromFixed(event.x);
        dust(ps, x, 12, 1.2, 1.6, fromFixed(event.y));
        this.camera.addTrauma(0.18);
        this.sound?.knockdown(this.pan(x));
        return;
      }
      case 'ko':
        this.knockout(event);
        return;
      case 'grab': {
        const x = fromFixed(event.x);
        const y = fromFixed(event.y);
        ps.spawn(K.star, x, y, { size: 0.05, size2: 0.32, life: 0.2, color: '#ffffff', rot: Math.PI / 4 });
        ps.spawn(K.ring, x, y, { size: 0.05, size2: 0.3, life: 0.22, color: this.inks[event.side].glow });
        this.views[event.target].limbFlash = 0.8;
        this.views[event.target].limbJoint = J.neck;
        this.camera.addTrauma(0.1);
        this.camera.zoomPunch(0.03);
        this.sound?.grab(this.pan(x));
        this.haptic?.('light');
        return;
      }
      case 'throw': {
        const x = fromFixed(event.x);
        const attacker = this.inks[event.side];
        const floor = fromFixed(event.y) - 0.15;
        dust(ps, x, 16, 1.4, 2, floor);
        if (!event.ko) {
          const ragdoll = this.activeRagdoll(event.target as 0 | 1);
          const facing = this.sim.fighters[event.side].facing;
          ragdoll.shove(facing * 0.8, -3.2);
          ragdoll.kick(J.head, facing * 1.5, -1.5);
          ragdoll.kick(J.lAnkle, facing * 1.2, 2.2);
          ragdoll.kick(J.rAnkle, facing * 1.6, 2.6);
        }
        ps.spawn(K.ring, x, floor + 0.03, { size: 0.15, size2: 1.1, life: 0.42, color: 'rgba(255,240,220,0.8)' });
        ps.spawn(K.burst, x, floor + 0.25, { size: 0.06, size2: 0.5, life: 0.3, color: '#ffffff', rot: Math.random() * 3 });
        inkSpray(ps, x, 0.3, 0, 1, 18, 6, attacker.ink, 0.026);
        this.popups.show('THROW', x, 1.5, { fill: '#ffffff', stroke: attacker.deep, size: 0.26, life: 0.85 });
        const target = this.views[event.target];
        target.squashVel = 6;
        target.squashAngle = -Math.PI / 2;
        target.flash = 0.8;
        this.flashAlpha = Math.max(this.flashAlpha, 0.2 * this.flashes);
        this.camera.addTrauma(0.38);
        this.camera.zoomPunch(0.07);
        this.sound?.slam(this.pan(x));
        this.haptic?.('heavy');
        return;
      }
      case 'clash': {
        const x = fromFixed(event.x);
        const y = fromFixed(event.y);
        sparks(ps, x, y, 14, 7, '#fff4d6');
        ps.spawn(K.ring, x, y, { size: 0.05, size2: 0.45, life: 0.3, color: '#ffffff' });
        this.popups.show('BREAK', x, y + 0.45, POP.blocked);
        this.camera.addTrauma(0.14);
        this.sound?.clash(this.pan(x));
        this.haptic?.('block');
        return;
      }
      case 'guardBreak': {
        const x = fromFixed(event.x);
        const y = fromFixed(event.y);
        for (let i = 0; i < 18; i++) {
          const a = Math.random() * Math.PI * 2;
          const v = 3 + Math.random() * 5;
          ps.spawn(K.shard, x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v + 1.5, life: 1.1, size: 0.035 + Math.random() * 0.04, rot: a, vr: (Math.random() - 0.5) * 18, color: 'rgba(200, 220, 255, 0.95)', gravity: 0.7 });
        }
        ps.spawn(K.ring, x, y, { size: 0.08, size2: 0.85, life: 0.4, color: '#cfe0ff' });
        sparks(ps, x, y, 12, 8, '#e4edff');
        this.popups.show('GUARD BREAK', x, y + 0.25, { fill: '#e9f0ff', stroke: '#1b3a92', size: 0.25, life: 1.1 });
        this.views[event.side].flash = 0.7;
        this.flashAlpha = Math.max(this.flashAlpha, 0.18 * this.flashes);
        this.camera.addTrauma(0.32);
        this.camera.zoomPunch(0.05);
        this.sound?.guardBreak(this.pan(x));
        this.haptic?.('heavy');
        return;
      }
      case 'tired': {
        const f = this.sim.fighters[event.side];
        const x = fromFixed(f.x);
        this.popups.show('TIRED', x, 2.05, { fill: '#e8e2d6', stroke: '#6f6a62', size: 0.15, life: 0.6, rise: 0.4 }, `tired${event.side}`);
        for (let i = 0; i < 4; i++) ps.spawn(K.puff, x + f.facing * 0.15, 1.55, { vx: f.facing * (0.3 + Math.random() * 0.4), vy: 0.3 + Math.random() * 0.3, life: 0.6, size: 0.02, size2: 0.07, color: 'rgba(240,236,228,0.6)', drag: 2 });
        this.sound?.tired(this.pan(x));
        return;
      }
      case 'roll': {
        const x = fromFixed(event.x);
        dust(ps, x, 8, 0.8, 1.1, fromFixed(event.y));
        this.sound?.roll(this.pan(x));
        return;
      }
      case 'ringout': {
        // Off the edge: slow motion while they tumble into the street (CB-8).
        const faller = this.sim.fighters[event.side];
        this.goLimp(event.side as 0 | 1, fromFixed(faller.vx) * 60, fromFixed(faller.vy) * 60);
        this.camera.edgeMargin = 3.2;
        this.slowmo = 1;
        this.koDim = 0.7;
        this.camera.focus(fromFixed(event.x), -0.6, 0.35, 2.4, 0);
        this.camera.addTrauma(0.2);
        this.sound?.fall();
        this.haptic?.('ko');
        return;
      }
    }
  }

  private knockout(event: Extract<SimEvent, { type: 'ko' }>): void {
    const ps = this.particles;
    const x = fromFixed(event.x);
    const y = fromFixed(event.y);
    const loser = this.sim.fighters[event.side];
    const winner = this.sim.fighters[1 - event.side];
    const ink = this.inks[1 - event.side];
    const view = this.views[event.side];
    // Freeze, invert one frame, then slow motion (GF-3).
    this.freeze = 0.32;
    this.slowmo = 1;
    this.invert = this.flashes >= 0.5 ? 3 : 0;
    this.flashAlpha = Math.max(this.flashAlpha, 0.5 * this.flashes);
    this.koDim = 1;
    ps.spawn(K.burst, x, y, { size: 0.08, size2: 0.8, life: 0.5, color: '#ffffff' });
    ps.spawn(K.burst, x, y, { size: 0.06, size2: 0.6, life: 0.6, color: ink.ink });
    ps.spawn(K.ring, x, y, { size: 0.1, size2: 1.6, life: 0.7, color: '#ffffff' });
    ps.spawn(K.ring, x, y, { size: 0.1, size2: 1.1, life: 0.55, color: ink.glow });
    inkSpray(ps, x, y, fromFixed(event.vx) * 60, fromFixed(event.vy) * 60, 40, 8, ink.ink, 0.03);
    sparks(ps, x, y, 26, 12, '#fff4d6');
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      ps.spawn(K.shard, x, y, { vx: Math.cos(a) * (3 + Math.random() * 5), vy: Math.sin(a) * (3 + Math.random() * 5) + 2, life: 1.6, size: 0.04 + Math.random() * 0.05, rot: a, vr: (Math.random() - 0.5) * 20, color: ink.ink, gravity: 0.8 });
    }
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 9 + Math.random() * 6;
      ps.spawn(K.streak, x + Math.cos(a) * 0.2, y + Math.sin(a) * 0.2, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.3, size: 0.015, size2: 0.6, color: 'rgba(255,255,255,0.95)', drag: 3 });
    }
    this.camera.addTrauma(0.75);
    this.camera.zoomPunch(0.14);
    this.camera.focus(x, y, 0.6, 2.2, 0.32);
    // The loser goes limp: a ragdoll launched along the final blow.
    this.goLimp(event.side as 0 | 1, fromFixed(event.vx) * 60, fromFixed(event.vy) * 60);
    view.flash = 1;
    void winner;
    this.sound?.ko();
    this.haptic?.('ko');
  }

  /** The fighter's active ragdoll (CB-8), made from where the body is drawn now if it has none. */
  private activeRagdoll(side: 0 | 1): Ragdoll {
    const view = this.views[side];
    view.release = 0;
    if (view.ragdoll?.active) return view.ragdoll;
    const f = this.sim.fighters[side];
    const ragdoll = this.makeRagdoll(view.world, fromFixed(f.vx) * 60, fromFixed(f.vy) * 60, 0, 0.6);
    ragdoll.active = true;
    ragdoll.target.set(view.world);
    view.target.set(view.world);
    ragdoll.tvx = fromFixed(f.vx) * 60;
    ragdoll.tvy = fromFixed(f.vy) * 60;
    view.ragdoll = ragdoll;
    return ragdoll;
  }

  /** A ragdoll that knows the arena and kicks up dust where it hits, scaled by loud. */
  private makeRagdoll(joints: Float32Array, vx: number, vy: number, spin: number, loud: number): Ragdoll {
    const ps = this.particles;
    const ragdoll = new Ragdoll(joints, vx, vy, spin);
    ragdoll.arenaWidth = fromFixed(this.sim.arenaWidth);
    ragdoll.dropLeft = this.sim.dropLeft;
    ragdoll.dropRight = this.sim.dropRight;
    ragdoll.ledges = this.ledges;
    ragdoll.onImpact = (speed, px, py) => {
      const strength = Math.min(1, speed / 8) * loud;
      dust(ps, px, 3 + Math.round(strength * 8), 0.6, 0.6 + strength * 1.4, py);
      if (strength > 0.25) this.camera.addTrauma(strength * 0.25);
      this.sound?.body(strength, this.pan(px));
    };
    return ragdoll;
  }

  /** Hands a fighter over to the cosmetic ragdoll, so slow motion applies to the fall. */
  private goLimp(side: 0 | 1, vx: number, vy: number): void {
    const f = this.sim.fighters[side];
    const view = this.views[side];
    // Already a ragdoll (a knockdown in progress): go limp from where it is.
    if (!view.ragdoll) for (let i = 0; i < JOINT_COUNT * 2; i++) view.world[i] = fromFixed(f.world[i]);
    view.ragdoll = this.makeRagdoll(view.world, vx, vy, -f.facing * 6.5 * (0.7 + Math.random() * 0.6), 1);
    view.release = 0;
  }

  // Frames.

  private targets() {
    const [a, b] = this.views;
    const ax = a.ragdoll ? a.ragdoll.centerX : a.cx;
    const bx = b.ragdoll ? b.ragdoll.centerX : b.cx;
    let top = 1.8;
    let bottom = 0;
    for (const view of this.views) {
      const t = view.ragdoll ? view.ragdoll.top : view.cy + 1.75;
      top = Math.max(top, t);
      bottom = Math.min(bottom, view.ragdoll ? view.ragdoll.bottom : view.cy);
    }
    return { x0: Math.min(ax, bx), x1: Math.max(ax, bx), top, bottom };
  }

  /** Advances cosmetic time and draws. `dtMs` is real time since the last frame. */
  frame(dtMs: number): void {
    this.lastFrameMs = this.lastFrameMs * 0.95 + dtMs * 0.05;
    const real = Math.min(dtMs, 100) / 1000;
    this.stepClock += real;
    // Cosmetic time: frozen on the KO impact, then slow motion easing back to normal.
    let dt = real;
    if (this.freeze > 0) {
      this.freeze -= real;
      dt = 0;
    } else if (this.slowmo > 0) {
      this.slowmo = Math.max(0, this.slowmo - real * 0.55);
      this.timeScale = 1 - this.slowmo * 0.78;
      dt = real * this.timeScale;
    } else {
      this.timeScale = 1;
    }
    this.time += dt;
    this.update(dt, real);
    this.draw();
  }

  /** The game-time seconds the last update covered (slow motion included). */
  private stepDt = 0;

  private update(dt: number, real: number): void {
    this.stepDt = dt;
    this.camera.shakeScale = this.shake;
    this.camera.update(this.freeze > 0 ? real * 0.15 : dt + (real - dt) * 0.35, this.targets());
    this.particles.update(dt);
    this.popups.update(real);
    if (!this.quiet || Math.random() < 0.5) this.arena.ambient(this.particles, this.camera, dt);
    this.flashAlpha = Math.max(0, this.flashAlpha - real * 4.5);
    this.koDim = Math.max(0, this.koDim - real * 0.5);
    for (const view of this.views) {
      this.muscles(view, real);
      view.ragdoll?.update(dt);
      // Squash and stretch: a stiff spring so limbs flex and snap back.
      view.squashVel += (-view.squash * 420 - view.squashVel * 18) * Math.min(real, 1 / 30);
      view.squash += view.squashVel * Math.min(real, 1 / 30);
      view.flash = Math.max(0, view.flash - real * 9);
      view.limbFlash = Math.max(0, view.limbFlash - real * 6);
      for (let i = 0; i < TIPS.length; i++) view.whooshCool[i] -= real;
      // Fade the recorded idle stance in while standing still, out as soon as anything happens.
      const f = this.sim.fighters[this.views[0] === view ? 0 : 1];
      const still = f.state === S.idle && f.walk === 0 && f.crouch === 0;
      view.idleW = Math.max(0, Math.min(1, view.idleW + (still ? real * 3 : -real * 12)));
      if (this.sim.hitstop === 0) view.jitter = Math.max(0, view.jitter - real * 10);
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    cam.applyShake(ctx);
    // Overdraw the edges so shake never shows a gap.
    ctx.save();
    ctx.translate(cam.width / 2, cam.height / 2);
    ctx.scale(1.06, 1.06);
    ctx.translate(-cam.width / 2, -cam.height / 2);
    this.arena.draw(ctx, cam, this.time);
    ctx.restore();
    this.particles.drawDecals(ctx, cam);
    this.particles.draw(ctx, cam, false);

    const alpha = Math.min(1, this.stepClock * 60);
    for (const view of this.views) this.place(view, alpha);
    this.drawShadows(ctx);
    const order = this.drawOrder();
    for (const side of order) this.drawTrails(ctx, side);
    for (const side of order) this.drawFighter(ctx, side);
    this.particles.draw(ctx, cam, true);
    this.popups.draw(ctx, cam);
    this.arena.drawFront(ctx, cam, this.time);
    ctx.restore();

    // Screen effects.
    if (this.koDim > 0) {
      ctx.fillStyle = `rgba(20, 12, 24, ${0.22 * this.koDim})`;
      ctx.fillRect(0, 0, cam.width, cam.height);
    }
    if (this.flashAlpha > 0) {
      ctx.fillStyle = `rgba(255, 252, 244, ${this.flashAlpha})`;
      ctx.fillRect(0, 0, cam.width, cam.height);
    }
    if (this.invert > 0) {
      // The inverted-colour impact frame on a knockout.
      this.invert -= 1;
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cam.width, cam.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(this.vignetteCanvas(), 0, 0, cam.width, cam.height);
    if (!this.quiet && this.lastFrameMs < 20) {
      const grain = paperGrain(ctx);
      if (grain) {
        ctx.fillStyle = grain;
        ctx.fillRect(0, 0, cam.width, cam.height);
      }
    }
  }

  /**
   * Sets an active ragdoll's muscles from what the fighter is doing: floppy in the air so limbs
   * flail, gathering through the knockdown, firm for the get-up, then a short blend back.
   */
  private muscles(view: View, real: number): void {
    const ragdoll = view.ragdoll;
    if (!ragdoll?.active) return;
    const f = this.sim.fighters[this.views[0] === view ? 0 : 1];
    if (view.release > 0) {
      view.release -= real;
      ragdoll.setMuscles(0.3, 0.5, 0.9);
      if (view.release <= 0) {
        view.release = 0;
        view.ragdoll = null;
      }
      return;
    }
    switch (f.state) {
      case S.launched:
        ragdoll.setMuscles(0.006, 0.25, 0.15);
        return;
      case S.knockdown: {
        const u = f.stunTotal > 0 ? 1 - f.stun / f.stunTotal : 1;
        ragdoll.setMuscles(0.01 + 0.05 * u * u, 0.25, 0.7);
        return;
      }
      case S.getup:
      case S.roll:
        ragdoll.setMuscles(0.2, 0.4, 0.9);
        return;
      default:
        view.release = RELEASE;
    }
  }

  /** Where the simulation's pose puts each joint this frame, metres. */
  private poseJoints(view: View, alpha: number, out: Float32Array): void {
    jointsBetween(view.prev, view.curr, alpha, view.local);
    const x = view.px + (view.cx - view.px) * alpha;
    const y = view.py + (view.cy - view.py) * alpha;
    for (let j = 0; j < JOINT_COUNT; j++) {
      out[2 * j] = x + view.facing * view.local[2 * j];
      out[2 * j + 1] = y + view.local[2 * j + 1];
    }
  }

  private place(view: View, alpha: number): void {
    const cam = this.camera;
    if (view.ragdoll?.active) {
      const ox = view.target[2 * J.pelvis];
      const oy = view.target[2 * J.pelvis + 1];
      this.poseJoints(view, alpha, view.target);
      view.ragdoll.target.set(view.target);
      // How fast the pose is carrying the body, for the ragdoll's root to match.
      if (this.stepDt > 0) {
        view.ragdoll.tvx = Math.max(-15, Math.min(15, (view.target[2 * J.pelvis] - ox) / this.stepDt));
        view.ragdoll.tvy = Math.max(-15, Math.min(15, (view.target[2 * J.pelvis + 1] - oy) / this.stepDt));
      }
      if (view.release > 0) {
        const w = 1 - view.release / RELEASE;
        const e = w * w * (3 - 2 * w);
        for (let i = 0; i < JOINT_COUNT * 2; i++) view.world[i] = view.ragdoll.pos[i] + (view.target[i] - view.ragdoll.pos[i]) * e;
      } else {
        view.world.set(view.ragdoll.pos);
      }
    } else if (view.ragdoll) {
      view.world.set(view.ragdoll.pos);
    } else {
      const side = this.views[0] === view ? 0 : 1;
      const idle = this.idles[side];
      if (idle && view.idleW > 0.001) {
        blendPose(view.prev, view.curr, Math.round(alpha * 65536), this.mixA);
        const frame = ((this.time * 60) % idle.frameCount + idle.frameCount) % idle.frameCount;
        sampleMove(idle, Math.floor(frame * 65536), this.mixIdle);
        this.mixIdle[0] = 0;
        blendPose(this.mixA, this.mixIdle, Math.round(view.idleW * 65536), this.mixB);
        jointsBetween(this.mixB, this.mixB, 0, view.local);
      } else {
        jointsBetween(view.prev, view.curr, alpha, view.local);
      }
      const x = view.px + (view.cx - view.px) * alpha;
      const y = view.py + (view.cy - view.py) * alpha;
      for (let j = 0; j < JOINT_COUNT; j++) {
        view.world[2 * j] = x + view.facing * view.local[2 * j];
        view.world[2 * j + 1] = y + view.local[2 * j + 1];
      }
    }
    // Squash and stretch about the pelvis, along the hit direction.
    const s = Math.max(-0.2, Math.min(0.2, view.squash * 0.04));
    const pelvisX = view.world[2 * J.pelvis];
    const pelvisY = view.world[2 * J.pelvis + 1];
    const ca = Math.cos(view.squashAngle);
    const sa = Math.sin(view.squashAngle);
    const jitter = this.sim.hitstop > 0 && view.jitter > 0 ? (Math.random() - 0.5) * 0.035 * this.shake : 0;
    for (let j = 0; j < JOINT_COUNT; j++) {
      let x = view.world[2 * j] - pelvisX;
      let y = view.world[2 * j + 1] - pelvisY;
      if (s !== 0) {
        const along = x * ca + y * sa;
        const across = -x * sa + y * ca;
        const a2 = along * (1 + s);
        const c2 = across * (1 - s * 0.6);
        x = a2 * ca - c2 * sa;
        y = a2 * sa + c2 * ca;
      }
      view.screen[2 * j] = cam.sx(pelvisX + x + jitter);
      view.screen[2 * j + 1] = cam.sy(pelvisY + y);
    }
    this.recordTrails(view);
  }

  private recordTrails(view: View): void {
    for (let i = 0; i < TIPS.length; i++) {
      const trail = view.trails[i];
      // Age out old points.
      while (trail.count > 0) {
        const oldest = (trail.head - trail.count + TRAIL_POINTS) % TRAIL_POINTS;
        if (this.time - trail.t[oldest] > TRAIL_SECONDS) trail.count -= 1;
        else break;
      }
      if (view.tipSpeed[i] < 4.2 || view.ragdoll) continue;
      const tip = TIPS[i];
      trail.x[trail.head] = view.world[2 * tip];
      trail.y[trail.head] = view.world[2 * tip + 1];
      trail.t[trail.head] = this.time;
      trail.head = (trail.head + 1) % TRAIL_POINTS;
      trail.count = Math.min(TRAIL_POINTS, trail.count + 1);
    }
  }

  private drawOrder(): [0 | 1, 0 | 1] {
    const [a, b] = this.sim.fighters;
    const attacking = (f: Fighter) => f.state === S.attack || f.state === S.throw || f.state === S.grab;
    if (attacking(a) && !attacking(b)) return [1, 0];
    if (attacking(b) && !attacking(a)) return [0, 1];
    return this.localSide === 0 ? [1, 0] : [0, 1];
  }

  private drawShadows(ctx: CanvasRenderingContext2D): void {
    const cam = this.camera;
    for (const view of this.views) {
      let minX = Infinity;
      let maxX = -Infinity;
      let low = Infinity;
      for (let j = 0; j < JOINT_COUNT; j++) {
        minX = Math.min(minX, view.world[2 * j]);
        maxX = Math.max(maxX, view.world[2 * j]);
        low = Math.min(low, view.world[2 * j + 1]);
      }
      const cx = (minX + maxX) / 2;
      const ground = this.groundAt(cx, low);
      const overVoid = (this.sim.dropLeft && cx < 0) || (this.sim.dropRight && cx > this.camera.arenaWidth) || low < ground - 0.05;
      if (overVoid) continue;
      const height = Math.max(0, low - ground);
      const fade = Math.max(0.2, 1 - height / 2.5);
      const w = (Math.max(0.36, maxX - minX) * 0.55 + 0.1) * fade;
      ctx.fillStyle = `rgba(20, 12, 20, ${0.26 * fade})`;
      ctx.beginPath();
      ctx.ellipse(cam.sx(cx), cam.sy(ground), w * cam.ppm, Math.max(2, w * cam.ppm * 0.16), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawTrails(ctx: CanvasRenderingContext2D, side: 0 | 1): void {
    const view = this.views[side];
    const ink = this.inks[side];
    const cam = this.camera;
    ctx.lineCap = 'round';
    for (let i = 0; i < TIPS.length; i++) {
      const trail = view.trails[i];
      if (trail.count < 2) continue;
      let prevX = 0;
      let prevY = 0;
      for (let n = 0; n < trail.count; n++) {
        const idx = (trail.head - trail.count + n + TRAIL_POINTS) % TRAIL_POINTS;
        const x = cam.sx(trail.x[idx]);
        const y = cam.sy(trail.y[idx]);
        if (n > 0) {
          const age = (this.time - trail.t[idx]) / TRAIL_SECONDS;
          const life = Math.max(0, 1 - age);
          ctx.strokeStyle = rgba(ink, 0.5 * life * (n / trail.count));
          ctx.lineWidth = Math.max(1, cam.ppm * 0.09 * (n / trail.count) * life);
          ctx.beginPath();
          ctx.moveTo(prevX, prevY);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        prevX = x;
        prevY = y;
      }
    }
  }

  private drawFighter(ctx: CanvasRenderingContext2D, side: 0 | 1): void {
    const view = this.views[side];
    const f = this.sim.fighters[side];
    const ink = this.inks[side];
    const cam = this.camera;

    // Smear frames: a fast limb is drawn stretched between where it was and where it is.
    if (!view.ragdoll) {
      for (let i = 0; i < TIPS.length; i++) {
        if (view.tipSpeed[i] < SMEAR_SPEED) continue;
        const tip = TIPS[i];
        const base = TIP_PARENT[i];
        const k = Math.min(1, (view.tipSpeed[i] - SMEAR_SPEED) / 6);
        ctx.fillStyle = rgba(ink, 0.22 + 0.2 * k);
        ctx.beginPath();
        ctx.moveTo(cam.sx(view.stepPrev[2 * base]), cam.sy(view.stepPrev[2 * base + 1]));
        ctx.lineTo(cam.sx(view.stepPrev[2 * tip]), cam.sy(view.stepPrev[2 * tip + 1]));
        ctx.lineTo(view.screen[2 * tip], view.screen[2 * tip + 1]);
        ctx.lineTo(view.screen[2 * base], view.screen[2 * base + 1]);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Fair warning: the striking limb glows during a heavy move's startup.
    let glow = 0;
    let glowJoint: number | undefined;
    const move = f.currentMove;
    if (move && f.state === S.attack && move.rules.strength === 2 && f.moveT < move.startup) {
      glow = (0.55 + 0.45 * Math.sin(this.time * 30)) * Math.min(1, f.moveT / 4);
      glowJoint = move.limb;
    }
    drawFigure(ctx, view.screen, {
      ink,
      scale: cam.ppm,
      facing: view.ragdoll && !view.ragdoll.active ? (view.screen[2 * J.head] > view.screen[2 * J.pelvis] ? 1 : -1) * 1 : view.facing,
      flash: view.flash,
      flashJoint: view.limbJoint,
      flashLimb: view.limbFlash,
      glow,
      glowJoint,
    });
    // A faint ring marks your fighter during the round intro.
    if (this.localSide === side && this.sim.phase === PHASE.intro && !this.quiet) {
      const x = view.screen[2 * J.pelvis];
      const y = cam.sy(0);
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
      ctx.strokeStyle = rgba(ink, 0.35 + 0.35 * pulse);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y, cam.ppm * (0.4 + pulse * 0.06), cam.ppm * 0.08, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private vignetteCanvas(): HTMLCanvasElement {
    if (this.vignette) return this.vignette;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const g = canvas.getContext('2d')!;
    const grad = g.createRadialGradient(128, 128, 60, 128, 128, 182);
    grad.addColorStop(0, 'rgba(20, 12, 24, 0)');
    grad.addColorStop(1, 'rgba(20, 12, 24, 0.38)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    this.vignette = canvas;
    return canvas;
  }
}

function ledgesInMetres(sim: FightSim): { x0: number; x1: number; top: number }[] {
  return sim.ledges.map((l) => ({ x0: fromFixed(l.x0), x1: fromFixed(l.x1), top: fromFixed(l.top) }));
}
