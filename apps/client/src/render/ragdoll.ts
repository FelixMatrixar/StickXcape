/**
 * A cosmetic ragdoll (GF-3, CB-8): Verlet points for the 17 joints held together by bone-length
 * constraints. It lives only in the renderer and never touches the deterministic simulation.
 *
 * Passive, it is a knockout or a fall: the body just flops. Active, it is a knockdown: the root
 * follows where the simulation has the body (so hits still land where they look), and muscles
 * pull each joint toward the simulation's pose around the ragdoll's own pelvis, stiffening as
 * the fighter recovers. Limbs flail from the hit, bounce off the floor, then gather back.
 */
import { BONE_METRES, JOINT_COUNT, PARENT, J } from '../engine/skeleton.ts';

const GRAVITY = 15;
const SUBSTEP = 1 / 120;

export class Ragdoll {
  readonly pos = new Float32Array(JOINT_COUNT * 2);
  readonly prev = new Float32Array(JOINT_COUNT * 2);
  /** Where each point was at the start of this step: tells a landing from a side hit. */
  private readonly from = new Float32Array(JOINT_COUNT * 2);
  private readonly links: [number, number, number][] = [];
  private acc = 0;
  arenaWidth = 10;
  dropLeft = false;
  dropRight = false;
  /** Solid ledges (AR-6), metres: land on the top, bounce off the sides. */
  ledges: readonly { x0: number; x1: number; top: number }[] = [];
  /** Fell past a drop edge: no floor any more. */
  private fallen = false;
  /** Called when a point hits the floor or a ledge hard, with the impact speed (m/s) and where. */
  onImpact: ((speed: number, x: number, y: number) => void) | null = null;
  private impactCooldown = 0;
  settled = 0;
  /** Active ragdoll: driven toward `target` (world joints, metres). */
  active = false;
  readonly target = new Float32Array(JOINT_COUNT * 2);
  /** Per 1/120 s step, the share of the gap closed: limbs toward the pose, the root toward its place. */
  limbK = 0;
  rootK = 0;
  /** Per step, the share of each joint's speed relative to the pelvis that the muscles soak up. */
  limbD = 0;
  /** How fast the simulation is moving the body (m/s): the root matches it, so kicks never carry the body off. */
  tvx = 0;
  tvy = 0;

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
    this.from.set(p);
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
    if (this.active) this.drive();
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
    if (!this.fallen && p[2 * J.pelvis + 1] < -0.3) this.fallen = true;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const radius = j === J.head ? 0.11 : 0.03;
      const x = p[2 * j];
      const overFloor = !this.fallen && !(this.dropLeft && x < 0) && !(this.dropRight && x > this.arenaWidth);
      if (overFloor && p[2 * j + 1] < radius) this.land(j, 0, radius);
      for (const ledge of this.ledges) {
        const px = p[2 * j];
        const py = p[2 * j + 1];
        if (px <= ledge.x0 - radius || px >= ledge.x1 + radius || py >= ledge.top + radius) continue;
        if (this.from[2 * j + 1] >= ledge.top + radius - 0.02) {
          // Came down on top.
          this.land(j, ledge.top, radius);
        } else {
          // Hit a side: out the way it came, losing most of the sideways speed.
          const left = this.from[2 * j] < (ledge.x0 + ledge.x1) / 2;
          p[2 * j] = left ? ledge.x0 - radius : ledge.x1 + radius;
          q[2 * j] = p[2 * j] + (p[2 * j] - q[2 * j]) * 0.3;
        }
      }
      if (!this.dropLeft && p[2 * j] < 0.15) {
        p[2 * j] = 0.15;
        q[2 * j] = p[2 * j] + (p[2 * j] - q[2 * j]) * 0.3;
      } else if (!this.dropRight && p[2 * j] > this.arenaWidth - 0.15) {
        p[2 * j] = this.arenaWidth - 0.15;
        q[2 * j] = p[2 * j] + (p[2 * j] - q[2 * j]) * 0.3;
      }
    }
  }

  /**
   * The active part. The whole body is shifted toward the simulation's pelvis without changing
   * its speed, so it goes where the fight says it is without wobbling about it. Then each joint
   * is pulled toward its place in the pose, measured from the ragdoll's own pelvis, with damping
   * on its speed relative to the pelvis: a spring and a damper, like a muscle. Weak, limbs flail;
   * strong, the body gathers itself into the pose.
   */
  private drive(): void {
    const p = this.pos;
    const q = this.prev;
    const t = this.target;
    const tpx = t[2 * J.pelvis];
    const tpy = t[2 * J.pelvis + 1];
    const dx = (tpx - p[2 * J.pelvis]) * this.rootK;
    const dy = (tpy - p[2 * J.pelvis + 1]) * this.rootK;
    // The body's average speed is steered toward the simulation's, so a kick spins and flails
    // the limbs without drifting the whole body away from where the fight has it.
    let mvx = 0;
    let mvy = 0;
    for (let j = 0; j < JOINT_COUNT; j++) {
      mvx += p[2 * j] - q[2 * j];
      mvy += p[2 * j + 1] - q[2 * j + 1];
    }
    const svx = (this.tvx * SUBSTEP - mvx / JOINT_COUNT) * this.rootK;
    const svy = (this.tvy * SUBSTEP - mvy / JOINT_COUNT) * this.rootK;
    for (let j = 0; j < JOINT_COUNT; j++) {
      p[2 * j] += dx;
      p[2 * j + 1] += dy;
      q[2 * j] += dx - svx;
      q[2 * j + 1] += dy - svy;
    }
    const px = p[2 * J.pelvis];
    const py = p[2 * J.pelvis + 1];
    const pvx = px - q[2 * J.pelvis];
    const pvy = py - q[2 * J.pelvis + 1];
    for (let j = 0; j < JOINT_COUNT; j++) {
      const vx = p[2 * j] - q[2 * j] - pvx;
      const vy = p[2 * j + 1] - q[2 * j + 1] - pvy;
      p[2 * j] += (px + t[2 * j] - tpx - p[2 * j]) * this.limbK - vx * this.limbD;
      p[2 * j + 1] += (py + t[2 * j + 1] - tpy - p[2 * j + 1]) * this.limbK - vy * this.limbD;
    }
  }

  /**
   * Sets the muscles: the pull toward the pose and toward the root's place (shares per step), and
   * how damped the limbs are as a ratio of critical: low lets them flail, near 1 settles them.
   */
  setMuscles(limbK: number, rootK: number, zeta: number): void {
    this.limbK = limbK;
    this.rootK = rootK;
    this.limbD = Math.min(0.9, 2 * zeta * Math.sqrt(limbK));
  }

  /** Adds a sudden velocity (m/s) to a joint, half as much to the joints either side of it. */
  kick(joint: number, vx: number, vy: number): void {
    const q = this.prev;
    const push = (j: number, share: number) => {
      q[2 * j] -= vx * share * SUBSTEP;
      q[2 * j + 1] -= vy * share * SUBSTEP;
    };
    push(joint, 1);
    if (PARENT[joint] >= 0) push(PARENT[joint], 0.5);
    for (let j = 0; j < JOINT_COUNT; j++) if (PARENT[j] === joint) push(j, 0.5);
  }

  /** Adds the same velocity (m/s) to the whole body. */
  shove(vx: number, vy: number): void {
    for (let j = 0; j < JOINT_COUNT; j++) {
      this.prev[2 * j] -= vx * SUBSTEP;
      this.prev[2 * j + 1] -= vy * SUBSTEP;
    }
  }

  /** A point touched a surface at height `top` from above: stop it there, bounce a little and slide with friction. */
  private land(j: number, top: number, radius: number): void {
    const p = this.pos;
    const q = this.prev;
    const vy = (p[2 * j + 1] - q[2 * j + 1]) / SUBSTEP;
    if (vy < -2.5 && this.impactCooldown <= 0 && this.onImpact) {
      this.impactCooldown = 0.12;
      this.onImpact(-vy, p[2 * j], top);
    }
    p[2 * j + 1] = top + radius;
    // Bounce a little (a quarter of the speed, upward) and slide with friction.
    q[2 * j + 1] = p[2 * j + 1] + Math.min(0, vy) * SUBSTEP * 0.25;
    q[2 * j] = p[2 * j] - (p[2 * j] - q[2 * j]) * 0.82;
  }

  /** Centre of the body, for the camera. */
  get centerX(): number {
    return this.pos[2 * J.pelvis];
  }

  get bottom(): number {
    let bottom = Infinity;
    for (let j = 0; j < JOINT_COUNT; j++) bottom = Math.min(bottom, this.pos[2 * j + 1]);
    return bottom;
  }

  get top(): number {
    let top = 0;
    for (let j = 0; j < JOINT_COUNT; j++) top = Math.max(top, this.pos[2 * j + 1]);
    return top;
  }
}
