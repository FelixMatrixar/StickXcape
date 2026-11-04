/**
 * A cosmetic ragdoll for knockouts (GF-3): Verlet points for the 17 joints held together by
 * bone-length constraints. The round is already decided when it starts, so it lives only in
 * the renderer and never touches the deterministic simulation.
 */
import { BONE_METRES, JOINT_COUNT, PARENT, J } from '../engine/skeleton.ts';

const GRAVITY = 15;
const SUBSTEP = 1 / 120;

export class Ragdoll {
  readonly pos = new Float32Array(JOINT_COUNT * 2);
  readonly prev = new Float32Array(JOINT_COUNT * 2);
  private readonly links: [number, number, number][] = [];
  private acc = 0;
  arenaWidth = 10;
  /** Called when a point hits the floor hard, with the impact speed (m/s). */
  onImpact: ((speed: number, x: number) => void) | null = null;
  private impactCooldown = 0;
  settled = 0;

  /** Starts from world joint positions (metres) with a launch velocity (m/s) and spin (rad/s). */
  constructor(joints: Float32Array, vx: number, vy: number, spin: number) {
    this.pos.set(joints);
    const px = joints[2 * J.pelvis];
    const py = joints[2 * J.pelvis + 1];
    for (let j = 0; j < JOINT_COUNT; j++) {
      const rx = joints[2 * j] - px;
      const ry = joints[2 * j + 1] - py;
      // v = linear + spin × r, with a little scatter so limbs flail.
      const jx = vx - spin * ry + (Math.random() - 0.5) * 0.6;
      const jy = vy + spin * rx + (Math.random() - 0.5) * 0.6;
      this.prev[2 * j] = joints[2 * j] - jx * SUBSTEP;
      this.prev[2 * j + 1] = joints[2 * j + 1] - jy * SUBSTEP;
    }
    for (let j = 0; j < JOINT_COUNT; j++) {
      const parent = PARENT[j];
      if (parent >= 0) this.links.push([parent, j, Math.max(0.03, BONE_METRES[j])]);
    }
    // Stiffeners keep the torso and head from folding flat.
    const keep = (a: number, b: number) => this.links.push([a, b, Math.hypot(joints[2 * a] - joints[2 * b], joints[2 * a + 1] - joints[2 * b + 1])]);
    keep(J.head, J.pelvis);
    keep(J.lShoulder, J.pelvis);
    keep(J.rShoulder, J.pelvis);
    keep(J.lHip, J.neck);
    keep(J.rHip, J.neck);
  }

  update(dt: number): void {
    this.acc += Math.min(dt, 0.1);
    this.impactCooldown -= dt;
    while (this.acc >= SUBSTEP) {
      this.acc -= SUBSTEP;
      this.step(SUBSTEP);
    }
  }

  private step(dt: number): void {
    const p = this.pos;
    const q = this.prev;
    let motion = 0;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const x = p[2 * j];
      const y = p[2 * j + 1];
      const vx = (x - q[2 * j]) * 0.995;
      const vy = (y - q[2 * j + 1]) * 0.995 - GRAVITY * dt * dt;
      q[2 * j] = x;
      q[2 * j + 1] = y;
      p[2 * j] = x + vx;
      p[2 * j + 1] = y + vy;
      motion += Math.abs(vx) + Math.abs(vy);
    }
    for (let iter = 0; iter < 6; iter++) {
      for (const [a, b, rest] of this.links) {
        const dx = p[2 * b] - p[2 * a];
        const dy = p[2 * b + 1] - p[2 * a + 1];
        const d = Math.hypot(dx, dy) || 0.0001;
        const diff = ((d - rest) / d) * 0.5;
        p[2 * a] += dx * diff;
        p[2 * a + 1] += dy * diff;
        p[2 * b] -= dx * diff;
        p[2 * b + 1] -= dy * diff;
      }
      this.collide();
    }
    this.settled = motion < 0.002 ? this.settled + dt : 0;
  }

  private collide(): void {
    const p = this.pos;
    const q = this.prev;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const radius = j === J.head ? 0.11 : 0.03;
      if (p[2 * j + 1] < radius) {
        const vy = (p[2 * j + 1] - q[2 * j + 1]) / SUBSTEP;
        if (vy < -2.5 && this.impactCooldown <= 0 && this.onImpact) {
          this.impactCooldown = 0.12;
          this.onImpact(-vy, p[2 * j]);
        }
        p[2 * j + 1] = radius;
        // Bounce a little (a quarter of the speed, upward) and slide with friction.
        q[2 * j + 1] = p[2 * j + 1] + Math.min(0, vy) * SUBSTEP * 0.25;
        q[2 * j] = p[2 * j] - (p[2 * j] - q[2 * j]) * 0.82;
      }
      if (p[2 * j] < 0.15) {
        p[2 * j] = 0.15;
        q[2 * j] = p[2 * j] + (p[2 * j] - q[2 * j]) * 0.3;
      } else if (p[2 * j] > this.arenaWidth - 0.15) {
        p[2 * j] = this.arenaWidth - 0.15;
        q[2 * j] = p[2 * j] + (p[2 * j] - q[2 * j]) * 0.3;
      }
    }
  }

  /** Centre of the body, for the camera. */
  get centerX(): number {
    return this.pos[2 * J.pelvis];
  }

  get top(): number {
    let top = 0;
    for (let j = 0; j < JOINT_COUNT; j++) top = Math.max(top, this.pos[2 * j + 1]);
    return top;
  }
}
