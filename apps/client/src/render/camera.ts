/**
 * The fight camera (CB-1): a side view that dollies in and out to keep both fighters framed,
 * rises to follow jumps, and adds trauma-based shake, zoom punches and snap focus on big
 * moments. Layers behind the fight plane sit at a depth, so dollying gives real parallax.
 */
export interface CameraTargets {
  x0: number;
  x1: number;
  /** Highest point either fighter reaches, metres. */
  top: number;
  /** Lowest point, when someone falls off a drop edge. */
  bottom?: number;
}

const FLOOR_ROW = 0.8;
const FLOOR_ROW_SHORT = 0.74;
const EYE_HEIGHT = 1.2;

export class FightCamera {
  width = 1;
  height = 1;
  /** Focal length in px·m: a layer at depth D shows at f / (distance + D) pixels per metre. */
  focal = 1000;
  x = 5;
  lift = 0;
  /** Pixels per metre on the fight plane. */
  ppm = 120;
  arenaWidth = 10;
  /** How far past the ends of the arena the view may show: more when the edges are drops. */
  edgeMargin = 0.6;

  /** Shake strength 0..1; the offset grows with its square. */
  trauma = 0;
  shakeScale = 1;
  shakeX = 0;
  shakeY = 0;
  shakeAngle = 0;
  private base = 120;
  private punch = 0;
  private punchVel = 0;
  private focusX = 0;
  private focusY = 0;
  private focusWeight = 0;
  private focusTime = 0;
  private focusHold = 0;
  private focusZoom = 0;
  private time = 0;
  private settled = false;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.focal = width * 1.15;
  }

  /** Pixels per metre at depth D behind the fight plane. */
  k(depth: number): number {
    return this.focal / (this.focal / this.ppm + depth);
  }

  get camY(): number {
    return EYE_HEIGHT + this.lift;
  }

  /** The screen row of the horizon (eye level). */
  get horizon(): number {
    return this.height * (this.height < 480 ? FLOOR_ROW_SHORT : FLOOR_ROW) - EYE_HEIGHT * this.ppm;
  }

  sx(x: number, depth = 0): number {
    return this.width / 2 + (x - this.x) * this.k(depth);
  }

  sy(y: number, depth = 0): number {
    return this.horizon + (this.camY - y) * this.k(depth);
  }

  /** Brief shake; 0.3 is a solid hit, 1 is a knockout. */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** A quick zoom-in that springs back. */
  zoomPunch(amount: number): void {
    this.punchVel += amount * 14;
  }

  /** Pulls the view toward a point for a moment (parry snap, KO). */
  focus(x: number, y: number, weight: number, seconds: number, zoom = 0.18): void {
    this.focusX = x;
    this.focusY = y;
    this.focusWeight = weight;
    this.focusTime = seconds;
    this.focusHold = seconds;
    this.focusZoom = zoom;
  }

  update(dt: number, targets: CameraTargets, snap = false): void {
    // A negative step would turn the easing below into overshoot, and the zoom can cross zero.
    dt = Math.max(0, dt);
    this.time += dt;
    const gap = Math.abs(targets.x1 - targets.x0);
    const span = Math.max(6, Math.min(10, gap + 3.8));
    let ppm = Math.min(this.width / span, this.height / 3.55);
    let x = (targets.x0 + targets.x1) / 2;
    // Rise for jumps; sink to follow a fall off a drop edge.
    const sink = Math.max(-0.8, Math.min(0, targets.bottom ?? 0)) * 0.7;
    const lift = Math.max(0, targets.top - 2.25) * 0.75 + sink;

    // Focus: lean toward a point and push in.
    if (this.focusTime > 0) {
      this.focusTime = Math.max(0, this.focusTime - dt);
      const w = this.focusWeight * Math.min(1, this.focusTime / Math.max(0.001, this.focusHold * 0.5));
      x += (this.focusX - x) * w;
      ppm *= 1 + this.focusZoom * w;
    }

    // Keep the walls near the edge of the frame, not deep inside it.
    const halfSpan = this.width / ppm / 2;
    const margin = this.edgeMargin;
    if (this.arenaWidth + 2 * margin > halfSpan * 2) x = Math.max(halfSpan - margin, Math.min(this.arenaWidth + margin - halfSpan, x));
    else x = this.arenaWidth / 2;

    if (snap || !this.settled) {
      this.x = x;
      this.base = ppm;
      this.lift = lift;
      this.settled = true;
    } else {
      const follow = 1 - Math.exp(-dt * 7);
      const zoom = 1 - Math.exp(-dt * 3.2);
      this.x += (x - this.x) * follow;
      this.base += (ppm - this.base) * zoom;
      this.lift += (lift - this.lift) * (1 - Math.exp(-dt * 5));
    }

    // Zoom punch: a damped spring on top of the framing zoom.
    const step = Math.min(dt, 1 / 30);
    this.punchVel += (-this.punch * 260 - this.punchVel * 22) * step;
    this.punch += this.punchVel * step;
    this.ppm = this.base * (1 + Math.max(-0.05, Math.min(0.2, this.punch)));
    void this.focusY;

    // Shake from trauma squared, using smooth noise.
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    const shake = this.trauma * this.trauma * this.shakeScale;
    const t = this.time * 38;
    const amp = Math.min(this.width, this.height) * 0.035;
    this.shakeX = shake * amp * (Math.sin(t * 1.1) * 0.6 + Math.sin(t * 2.7 + 1.3) * 0.4);
    this.shakeY = shake * amp * (Math.sin(t * 1.7 + 0.4) * 0.6 + Math.sin(t * 3.1 + 2.1) * 0.4);
    this.shakeAngle = shake * 0.03 * Math.sin(t * 1.3 + 0.7);
  }

  /** Applies the shake to a context about to draw the world. */
  applyShake(ctx: CanvasRenderingContext2D): void {
    if (this.shakeX === 0 && this.shakeY === 0 && this.shakeAngle === 0) return;
    ctx.translate(this.width / 2 + this.shakeX, this.height / 2 + this.shakeY);
    ctx.rotate(this.shakeAngle);
    ctx.translate(-this.width / 2, -this.height / 2);
  }
}
