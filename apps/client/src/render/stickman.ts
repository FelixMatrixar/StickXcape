/**
 * The stick man (LS-1 to LS-4): thick ink strokes with round ends and a brush taper, a round
 * head with a notch showing which way he faces, fists as dots, far limbs thinner and a shade
 * darker, and a light outline so he reads on any background.
 */
import { J } from '../engine/skeleton.ts';
import type { Ink } from './inks.ts';

export interface FigureStyle {
  ink: Ink;
  /** Pixels per metre. */
  scale: number;
  facing: number;
  alpha?: number;
  /** 0..1: the whole figure flashes white. */
  flash?: number;
  /** A struck joint whose bone flashes white, and how strongly. */
  flashJoint?: number;
  flashLimb?: number;
  /** The striking limb glows during a heavy move's startup (fair warning). */
  glowJoint?: number;
  glow?: number;
  outline?: string | null;
  /** Thickness multiplier. */
  weight?: number;
}

type Bone = readonly [from: number, to: number, w1: number, w2: number];

/** Bone widths in metres at each end: thicker at the body, thinner at the tip. */
const SPINE: Bone = [J.pelvis, J.neck, 0.078, 0.062];
const NECK: Bone = [J.neck, J.head, 0.05, 0.045];
const LEFT_ARM: readonly Bone[] = [
  [J.lShoulder, J.lElbow, 0.056, 0.047],
  [J.lElbow, J.lWrist, 0.047, 0.04],
];
const RIGHT_ARM: readonly Bone[] = [
  [J.rShoulder, J.rElbow, 0.056, 0.047],
  [J.rElbow, J.rWrist, 0.047, 0.04],
];
const LEFT_LEG: readonly Bone[] = [
  [J.lHip, J.lKnee, 0.068, 0.054],
  [J.lKnee, J.lAnkle, 0.054, 0.043],
  [J.lAnkle, J.lToe, 0.042, 0.03],
];
const RIGHT_LEG: readonly Bone[] = [
  [J.rHip, J.rKnee, 0.068, 0.054],
  [J.rKnee, J.rAnkle, 0.054, 0.043],
  [J.rAnkle, J.rToe, 0.042, 0.03],
];
const ALL: readonly Bone[] = [SPINE, NECK, ...LEFT_ARM, ...RIGHT_ARM, ...LEFT_LEG, ...RIGHT_LEG];

export const HEAD_RADIUS_M = 0.112;
const FIST_M = 0.046;
const OUTLINE_M = 0.03;
const FAR_SCALE = 0.82;

/** Adds a tapered capsule to the current path, wound the same way as arcs so unions fill solid. */
function capsule(ctx: CanvasRenderingContext2D, x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len > 0.001) {
    const nx = -dy / len;
    const ny = dx / len;
    ctx.moveTo(x1 - nx * r1, y1 - ny * r1);
    ctx.lineTo(x2 - nx * r2, y2 - ny * r2);
    ctx.lineTo(x2 + nx * r2, y2 + ny * r2);
    ctx.lineTo(x1 + nx * r1, y1 + ny * r1);
    ctx.closePath();
  }
  ctx.moveTo(x1 + r1, y1);
  ctx.arc(x1, y1, r1, 0, Math.PI * 2);
  ctx.moveTo(x2 + r2, y2);
  ctx.arc(x2, y2, r2, 0, Math.PI * 2);
}

function bones(ctx: CanvasRenderingContext2D, p: Float32Array, list: readonly Bone[], scale: number, pad: number, mul: number): void {
  for (const [a, b, w1, w2] of list) {
    capsule(ctx, p[2 * a], p[2 * a + 1], (w1 * mul * 0.5 + pad) * scale, p[2 * b], p[2 * b + 1], (w2 * mul * 0.5 + pad) * scale);
  }
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

/** Draws the figure from screen-space joint positions (x, y per joint, in pixels). */
export function drawFigure(ctx: CanvasRenderingContext2D, p: Float32Array, style: FigureStyle): void {
  const s = style.scale * (style.weight ?? 1);
  const facingRight = style.facing > 0;
  const nearArm = facingRight ? LEFT_ARM : RIGHT_ARM;
  const farArm = facingRight ? RIGHT_ARM : LEFT_ARM;
  const nearLeg = facingRight ? LEFT_LEG : RIGHT_LEG;
  const farLeg = facingRight ? RIGHT_LEG : LEFT_LEG;
  const nearWrist = facingRight ? J.lWrist : J.rWrist;
  const farWrist = facingRight ? J.rWrist : J.lWrist;
  const headR = HEAD_RADIUS_M * style.scale;
  const hx = p[2 * J.head];
  const hy = p[2 * J.head + 1];
  ctx.save();
  if (style.alpha !== undefined) ctx.globalAlpha = style.alpha;

  // Light outline around everything.
  if (style.outline !== null) {
    ctx.fillStyle = style.outline ?? 'rgba(255,250,240,0.92)';
    ctx.beginPath();
    bones(ctx, p, ALL, s, OUTLINE_M, 1);
    circle(ctx, hx, hy, headR + OUTLINE_M * s);
    circle(ctx, p[2 * J.lWrist], p[2 * J.lWrist + 1], (FIST_M + OUTLINE_M) * s);
    circle(ctx, p[2 * J.rWrist], p[2 * J.rWrist + 1], (FIST_M + OUTLINE_M) * s);
    ctx.fill();
  }

  // Fair-warning glow under the striking limb.
  if (style.glow && style.glow > 0 && style.glowJoint !== undefined) glowLimb(ctx, p, style.glowJoint, s, style.ink.glow, style.glow);

  // Far side: thinner and darker.
  ctx.fillStyle = style.ink.deep;
  ctx.beginPath();
  bones(ctx, p, farArm, s, 0, FAR_SCALE);
  bones(ctx, p, farLeg, s, 0, FAR_SCALE);
  circle(ctx, p[2 * farWrist], p[2 * farWrist + 1], FIST_M * FAR_SCALE * s);
  ctx.fill();

  // Body and head.
  ctx.fillStyle = style.ink.ink;
  ctx.beginPath();
  bones(ctx, p, [SPINE, NECK], s, 0, 1);
  circle(ctx, hx, hy, headR);
  ctx.fill();

  // The notch: which way he faces.
  const nx = hx - p[2 * J.neck];
  const ny = hy - p[2 * J.neck + 1];
  const len = Math.hypot(nx, ny) || 1;
  let fx = -ny / len;
  let fy = nx / len;
  if ((fx > 0) !== facingRight) {
    fx = -fx;
    fy = -fy;
  }
  ctx.fillStyle = style.outline ?? 'rgba(255,250,240,0.95)';
  ctx.beginPath();
  const ux = nx / len;
  const uy = ny / len;
  ctx.moveTo(hx + fx * headR * 0.32 + ux * headR * 0.08, hy + fy * headR * 0.32 + uy * headR * 0.08);
  ctx.lineTo(hx + fx * headR * 1.08 + ux * headR * 0.34, hy + fy * headR * 1.08 + uy * headR * 0.34);
  ctx.lineTo(hx + fx * headR * 1.08 - ux * headR * 0.06, hy + fy * headR * 1.08 - uy * headR * 0.06);
  ctx.closePath();
  ctx.fill();

  // Near side on top.
  ctx.fillStyle = style.ink.ink;
  ctx.beginPath();
  bones(ctx, p, nearLeg, s, 0, 1);
  bones(ctx, p, nearArm, s, 0, 1);
  circle(ctx, p[2 * nearWrist], p[2 * nearWrist + 1], FIST_M * s);
  ctx.fill();

  // A struck limb flashes white; a big hit flashes the whole figure.
  if (style.flashLimb && style.flashLimb > 0 && style.flashJoint !== undefined) {
    ctx.globalAlpha = (style.alpha ?? 1) * style.flashLimb;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    const joint = style.flashJoint;
    for (const bone of ALL) if (bone[1] === joint || bone[0] === joint) bones(ctx, p, [bone], s, 0.004, 1);
    if (joint === J.head) circle(ctx, hx, hy, headR);
    ctx.fill();
  }
  if (style.flash && style.flash > 0) {
    ctx.globalAlpha = (style.alpha ?? 1) * style.flash;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    bones(ctx, p, ALL, s, 0.004, 1);
    circle(ctx, hx, hy, headR);
    ctx.fill();
  }
  ctx.restore();
}

function glowLimb(ctx: CanvasRenderingContext2D, p: Float32Array, joint: number, s: number, color: string, amount: number): void {
  const chain = ALL.filter((bone) => bone[1] === joint || bone[0] === joint);
  const base = ctx.globalAlpha;
  ctx.fillStyle = color;
  for (const [pad, alpha] of [
    [0.09, 0.14],
    [0.05, 0.26],
  ] as const) {
    ctx.globalAlpha = base * alpha * amount;
    ctx.beginPath();
    bones(ctx, p, chain, s, pad, 1);
    circle(ctx, p[2 * joint], p[2 * joint + 1], (pad + 0.05) * s);
    ctx.fill();
  }
  ctx.globalAlpha = base;
}
