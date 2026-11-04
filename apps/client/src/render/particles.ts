/**
 * Ink effects: droplets, sparks, dust, rings, bursts, shards, speed lines, shield arcs and
 * floor splats. Everything lives in world metres so it moves with the camera. A fixed pool,
 * so a big knockout never allocates mid-fight.
 */
import type { FightCamera } from './camera.ts';

export const K = {
  drop: 0,
  spark: 1,
  puff: 2,
  ring: 3,
  burst: 4,
  shard: 5,
  streak: 6,
  decal: 7,
  arc: 8,
  leaf: 9,
  mote: 10,
  star: 11,
} as const;

export interface Particle {
  alive: boolean;
  kind: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  size2: number;
  rot: number;
  vr: number;
  color: string;
  alpha: number;
  gravity: number;
  drag: number;
  depth: number;
  seed: number;
  /** Drawn in front of the fighters. */
  front: boolean;
}

const GRAVITY = 14;
const POOL = 900;

export class Particles {
  readonly pool: Particle[] = [];
  private next = 0;
  /** Splats that stay on the floor for the round. */
  readonly decals: Particle[] = [];

  constructor() {
    for (let i = 0; i < POOL; i++) {
      this.pool.push({ alive: false, kind: 0, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 0, size2: 0, rot: 0, vr: 0, color: '#000', alpha: 1, gravity: 0, drag: 0, depth: 0, seed: 0, front: true });
    }
  }

  spawn(kind: number, x: number, y: number, init: Partial<Particle> = {}): Particle {
    // Reuse the oldest slot when full.
    let p = this.pool[this.next];
    for (let tries = 0; tries < POOL && p.alive; tries++) {
      this.next = (this.next + 1) % POOL;
      p = this.pool[this.next];
    }
    this.next = (this.next + 1) % POOL;
    p.alive = true;
    p.kind = kind;
    p.x = x;
    p.y = y;
    p.vx = init.vx ?? 0;
    p.vy = init.vy ?? 0;
    p.max = init.max ?? init.life ?? 0.5;
    p.life = p.max;
    p.size = init.size ?? 0.05;
    p.size2 = init.size2 ?? p.size;
    p.rot = init.rot ?? 0;
    p.vr = init.vr ?? 0;
    p.color = init.color ?? '#1d1b1a';
    p.alpha = init.alpha ?? 1;
    p.gravity = init.gravity ?? 0;
    p.drag = init.drag ?? 0;
    p.depth = init.depth ?? 0;
    p.seed = init.seed ?? Math.random() * 1000;
    p.front = init.front ?? true;
    return p;
  }

  clearDecals(): void {
    this.decals.length = 0;
  }

  clear(): void {
    for (const p of this.pool) p.alive = false;
    this.decals.length = 0;
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        continue;
      }
      if (p.drag > 0) {
        const d = Math.exp(-p.drag * dt);
        p.vx *= d;
        p.vy *= d;
      }
      p.vy -= GRAVITY * p.gravity * dt;
      if (p.kind === K.leaf) {
        p.vx += Math.sin(p.life * 3 + p.seed) * 0.9 * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.kind === K.drop && p.y <= 0.004 && p.vy < 0) {
        // Ink hits the floor and leaves a splat (GF-7, kept light).
        p.alive = false;
        if (this.decals.length < 70) {
          this.decals.push({ ...p, alive: true, kind: K.decal, y: 0, life: 9999, max: 9999, size: p.size * (1.6 + Math.random()), size2: p.size * (0.5 + Math.random() * 0.35) });
        }
      }
      if ((p.kind === K.shard || p.kind === K.leaf) && p.y < 0.01) {
        p.y = 0.01;
        p.vy = Math.abs(p.vy) * 0.25;
        p.vx *= 0.6;
        p.vr *= 0.5;
      }
    }
  }

  drawDecals(ctx: CanvasRenderingContext2D, cam: FightCamera): void {
    for (const d of this.decals) {
      const sx = cam.sx(d.x);
      const sy = cam.sy(0);
      const k = cam.ppm;
      ctx.globalAlpha = 0.5 * d.alpha;
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.ellipse(sx, sy + 1, d.size * k, Math.max(1.2, d.size2 * k * 0.35), 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  draw(ctx: CanvasRenderingContext2D, cam: FightCamera, front: boolean): void {
    for (const p of this.pool) {
      if (!p.alive || p.front !== front) continue;
      const t = 1 - p.life / p.max;
      const k = cam.k(p.depth);
      const sx = cam.sx(p.x, p.depth);
      const sy = cam.sy(p.y, p.depth);
      switch (p.kind) {
        case K.drop: {
          ctx.globalAlpha = p.alpha * Math.min(1, p.life / p.max * 2.5);
          ctx.fillStyle = p.color;
          const r = Math.max(0.8, p.size * k * (1 - t * 0.4));
          // Droplets stretch along their motion.
          const speed = Math.hypot(p.vx, p.vy);
          const stretch = Math.min(3, 1 + speed * 0.12);
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(Math.atan2(-p.vy, p.vx));
          ctx.beginPath();
          ctx.ellipse(0, 0, r * stretch, r, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        case K.spark: {
          ctx.globalAlpha = p.alpha * (1 - t);
          ctx.strokeStyle = p.color;
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(1, p.size * k * (1 - t * 0.6));
          const len = 0.012 * k * Math.min(1, Math.hypot(p.vx, p.vy) / 8) * 6;
          const a = Math.atan2(-p.vy, p.vx);
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx - Math.cos(a) * len, sy - Math.sin(a) * len);
          ctx.stroke();
          break;
        }
        case K.puff: {
          ctx.globalAlpha = p.alpha * (1 - t) * (1 - t);
          ctx.fillStyle = p.color;
          const r = (p.size + (p.size2 - p.size) * (1 - (1 - t) * (1 - t))) * k;
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(0.5, r), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case K.ring: {
          const ease = 1 - (1 - t) * (1 - t) * (1 - t);
          ctx.globalAlpha = p.alpha * (1 - t);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, (1 - t) * p.size * 0.35 * k);
          ctx.beginPath();
          ctx.arc(sx, sy, (p.size + (p.size2 - p.size) * ease) * k, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case K.burst:
        case K.star: {
          const ease = 1 - (1 - t) * (1 - t);
          ctx.globalAlpha = p.alpha * (1 - t * t);
          ctx.fillStyle = p.color;
          const r = (p.size + (p.size2 - p.size) * ease) * k;
          const spikes = p.kind === K.star ? 4 : 9;
          ctx.beginPath();
          for (let i = 0; i <= spikes * 2; i++) {
            const angle = p.rot + (i / (spikes * 2)) * Math.PI * 2;
            const jag = p.kind === K.star ? 1 : 0.75 + 0.5 * Math.abs(Math.sin(p.seed * 7.13 + i * 3.7));
            const rr = i % 2 === 0 ? r * jag : r * (p.kind === K.star ? 0.22 : 0.42);
            const px = sx + Math.cos(angle) * rr;
            const py = sy + Math.sin(angle) * rr;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          break;
        }
        case K.shard: {
          ctx.globalAlpha = p.alpha * Math.min(1, (p.life / p.max) * 3);
          ctx.fillStyle = p.color;
          const r = p.size * k;
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(p.rot);
          ctx.beginPath();
          ctx.moveTo(r, 0);
          ctx.lineTo(-r * 0.6, r * 0.45);
          ctx.lineTo(-r * 0.4, -r * 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case K.streak: {
          // Speed lines fly outward from an impact.
          ctx.globalAlpha = p.alpha * (1 - t);
          ctx.strokeStyle = p.color;
          ctx.lineCap = 'round';
          const a = Math.atan2(-p.vy, p.vx);
          const len = p.size2 * k * (1 - t * 0.5);
          ctx.lineWidth = Math.max(1, p.size * k * (1 - t));
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx - Math.cos(a) * len, sy - Math.sin(a) * len);
          ctx.stroke();
          break;
        }
        case K.arc: {
          // A shield arc in front of a blocker; rot is the direction it faces.
          const ease = 1 - (1 - t) * (1 - t);
          ctx.globalAlpha = p.alpha * (1 - t);
          ctx.strokeStyle = p.color;
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(1.5, p.size * 0.18 * k * (1 - t * 0.5));
          ctx.beginPath();
          ctx.arc(sx, sy, (p.size + (p.size2 - p.size) * ease) * k, p.rot - 0.95, p.rot + 0.95);
          ctx.stroke();
          ctx.globalAlpha = p.alpha * (1 - t) * 0.18;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.arc(sx, sy, (p.size + (p.size2 - p.size) * ease) * k, p.rot - 0.95, p.rot + 0.95);
          ctx.closePath();
          ctx.fill();
          break;
        }
        case K.leaf: {
          ctx.globalAlpha = p.alpha * Math.min(1, p.life / 1.5) * Math.min(1, (p.max - p.life) / 0.6);
          ctx.fillStyle = p.color;
          const r = p.size * k;
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(p.rot);
          ctx.scale(1, Math.abs(Math.sin(p.rot * 1.7)) * 0.7 + 0.3);
          ctx.beginPath();
          ctx.ellipse(0, 0, r, r * 0.42, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }
        case K.mote: {
          ctx.globalAlpha = p.alpha * Math.min(1, p.life / 1.2) * Math.min(1, (p.max - p.life) / 1.2) * (0.6 + 0.4 * Math.sin(p.life * 5 + p.seed));
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(0.7, p.size * k), 0, Math.PI * 2);
          ctx.fill();
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** A burst of ink droplets thrown along a direction (radians, screen-up positive y). */
export function inkSpray(ps: Particles, x: number, y: number, dirX: number, dirY: number, count: number, speed: number, color: string, size = 0.022): void {
  for (let i = 0; i < count; i++) {
    const spread = (Math.random() - 0.5) * 1.5;
    const a = Math.atan2(dirY, dirX) + spread;
    const v = speed * (0.35 + Math.random() * 0.9);
    ps.spawn(K.drop, x, y, {
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v + Math.random() * 1.5,
      life: 0.5 + Math.random() * 0.5,
      size: size * (0.5 + Math.random()),
      color,
      gravity: 1,
      drag: 1.2,
    });
  }
}

export function sparks(ps: Particles, x: number, y: number, count: number, speed: number, color: string, dirX = 0, dirY = 0, spread = Math.PI): void {
  const base = Math.atan2(dirY, dirX || 0.0001);
  for (let i = 0; i < count; i++) {
    const a = dirX === 0 && dirY === 0 ? Math.random() * Math.PI * 2 : base + (Math.random() - 0.5) * spread;
    const v = speed * (0.5 + Math.random() * 0.8);
    ps.spawn(K.spark, x, y, { vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.16 + Math.random() * 0.2, size: 0.014 + Math.random() * 0.012, color, drag: 6, gravity: 0.25 });
  }
}

/** Puffs kicked up from the ground (or a ledge top) at height y. */
export function dust(ps: Particles, x: number, count: number, spread: number, strength = 1, y = 0, color = 'rgba(120,105,90,0.55)'): void {
  for (let i = 0; i < count; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    ps.spawn(K.puff, x + (Math.random() - 0.5) * spread * 0.3, y + 0.03 + Math.random() * 0.05, {
      vx: side * (0.4 + Math.random() * 1.6) * strength,
      vy: 0.15 + Math.random() * 0.5 * strength,
      life: 0.45 + Math.random() * 0.4,
      size: 0.035 + Math.random() * 0.03,
      size2: (0.09 + Math.random() * 0.1) * Math.min(1.8, 0.6 + strength * 0.5),
      color,
      drag: 3.5,
      front: Math.random() < 0.5,
    });
  }
}
