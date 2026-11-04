import { decodeFrames, FRAME_VALUES, type MoveFile } from '@sticxcape/shared';
import { encodeGreyPng } from '../lib/png.ts';

/**
 * Draws a move as stick figures, so Muse Spark can see what a taunt or victory move looks like
 * before strangers do. The skeleton follows the game's (apps/client/src/engine/skeleton.ts):
 * each joint's angle turns the bone ending at it, relative to its parent's bone; world angle 0
 * points up and a quarter turn points forward. This copy only draws, in floating point, so a
 * small difference from the engine would only move a line, never change a fight.
 */

/** Parent of each joint, in the move format's JOINTS order; -1 for the pelvis. */
const PARENT = [1, 2, -1, 1, 3, 4, 1, 6, 7, 2, 9, 10, 11, 2, 13, 14, 15] as const;
/** Parents before children. */
const FK_ORDER = [2, 1, 0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;
/** Length in metres of the bone ending at each joint. */
const BONE_METRES = [0.2, 0.5, 0, 0.03, 0.28, 0.26, 0.03, 0.28, 0.26, 0.03, 0.44, 0.43, 0.14, 0.03, 0.44, 0.43, 0.14] as const;
/** The lines drawn: spine, neck, arms and legs (shoulders and hips sit on the spine). */
const BONES = [
  [2, 1],
  [1, 0],
  [3, 4],
  [4, 5],
  [6, 7],
  [7, 8],
  [9, 10],
  [10, 11],
  [11, 12],
  [13, 14],
  [14, 15],
  [15, 16],
] as const;
const HEAD_METRES = 0.11;
const TURN = Math.PI * 2;

/** Joint positions in metres (x forward, y up) for the frame starting at `at`. */
export function jointPositions(values: Int16Array, at: number): Float64Array {
  const out = new Float64Array(PARENT.length * 2);
  const world = new Float64Array(PARENT.length);
  for (const j of FK_ORDER) {
    const angle = (values[at + 2 + j]! / 65536) * TURN;
    const parent = PARENT[j];
    if (parent < 0) {
      world[j] = angle;
      out[2 * j] = values[at]! / 1000;
      out[2 * j + 1] = values[at + 1]! / 1000;
      continue;
    }
    world[j] = world[parent]! + angle;
    out[2 * j] = out[2 * parent]! + BONE_METRES[j] * Math.sin(world[j]!);
    out[2 * j + 1] = out[2 * parent + 1]! + BONE_METRES[j] * Math.cos(world[j]!);
  }
  return out;
}

export const SHEET_COLUMNS = 3;
export const SHEET_ROWS = 2;
const PANEL_WIDTH = 200;
const PANEL_HEIGHT = 240;
const FLOOR_MARGIN = 24;
const INK = 24;
const RULE = 200;

/**
 * Six frames of the move, evenly spaced from first to last, as a 3-by-2 greyscale PNG read left
 * to right and top to bottom. Each figure faces right and stands on a floor line, centred on its
 * pelvis; all six share one scale, so a jump still looks like a jump.
 */
export function moveSheet(move: MoveFile): Uint8Array {
  const values = decodeFrames(move.frames);
  if (!values) throw new Error('The move has no frames');
  const frames = values.length / FRAME_VALUES;
  const count = SHEET_COLUMNS * SHEET_ROWS;
  const picks = Array.from({ length: count }, (_, i) => Math.round((i * (frames - 1)) / (count - 1)));
  const poses = picks.map((f) => jointPositions(values, f * FRAME_VALUES));

  // One scale for every panel: about 100 px a metre, smaller if a pose reaches higher.
  let top = 0;
  for (const pose of poses) for (let j = 0; j < PARENT.length; j++) top = Math.max(top, pose[2 * j + 1]! + (j === 0 ? HEAD_METRES : 0));
  const scale = Math.min(100, (PANEL_HEIGHT - FLOOR_MARGIN - 12) / Math.max(top, 0.5));

  const width = PANEL_WIDTH * SHEET_COLUMNS;
  const height = PANEL_HEIGHT * SHEET_ROWS;
  const pixels = new Uint8Array(width * height).fill(255);
  const dot = (x: number, y: number, r: number, shade: number, clip: [number, number, number, number]) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = Math.round(x + dx);
        const py = Math.round(y + dy);
        if (px < clip[0] || py < clip[1] || px >= clip[2] || py >= clip[3]) continue;
        pixels[py * width + px] = shade;
      }
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, r: number, shade: number, clip: [number, number, number, number]) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) dot(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, r, shade, clip);
  };

  poses.forEach((pose, i) => {
    const left = (i % SHEET_COLUMNS) * PANEL_WIDTH;
    const upper = Math.floor(i / SHEET_COLUMNS) * PANEL_HEIGHT;
    const clip: [number, number, number, number] = [left, upper, left + PANEL_WIDTH, upper + PANEL_HEIGHT];
    const floor = upper + PANEL_HEIGHT - FLOOR_MARGIN;
    const centre = pose[2 * 2]!;
    const toX = (x: number) => left + PANEL_WIDTH / 2 + (x - centre) * scale;
    const toY = (y: number) => floor - y * scale;
    line(left + 8, floor, left + PANEL_WIDTH - 8, floor, 0, RULE, clip);
    for (const [a, b] of BONES) line(toX(pose[2 * a]!), toY(pose[2 * a + 1]!), toX(pose[2 * b]!), toY(pose[2 * b + 1]!), 2, INK, clip);
    dot(toX(pose[0]!), toY(pose[1]!), Math.round(HEAD_METRES * scale), INK, clip);
  });
  // Thin rules between the panels.
  for (let c = 1; c < SHEET_COLUMNS; c++) for (let y = 0; y < height; y++) pixels[y * width + c * PANEL_WIDTH] = RULE;
  for (let r = 1; r < SHEET_ROWS; r++) pixels.fill(RULE, r * PANEL_HEIGHT * width, (r * PANEL_HEIGHT + 1) * width);
  return encodeGreyPng(width, height, pixels);
}
