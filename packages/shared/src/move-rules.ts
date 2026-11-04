import { decodeFrames, FRAME_VALUES, JOINTS, type MoveFile } from './move.ts';

/**
 * What the server re-checks before it signs a move for quick match (MP-8): wide limits that
 * catch hand-edited files (a body that teleports, a limb that spins round in one frame) without
 * depending on the fight engine's skeleton. The default moveset's sharpest frames reach 461 mm
 * and 85°. The engine's finer limits (17 m/s at a fist or foot, human joint ranges) stay in the
 * client's cleanup until they move into this package.
 */
export const MOVE_RULES = {
  /** The root (pelvis) moves at most this far between frames: 750 mm is 45 m/s. */
  maxRootStepMm: 750,
  /** Every joint turns at most a third of a turn between frames (21845 of 65536 units, 120°). */
  maxJointStep: 21845,
  /** The root stays within 6 m of where the move starts... */
  maxRootXMm: 6000,
  /** ...and between 0.3 m under the floor and 3 m above it. */
  minRootYMm: -300,
  maxRootYMm: 3000,
} as const;

/** Why a move breaks the rules, or null when it keeps them. Assumes a move that parsed. */
export function moveRuleProblem(move: MoveFile): string | null {
  const values = decodeFrames(move.frames);
  if (!values) return 'its frames do not decode';
  const frames = values.length / FRAME_VALUES;
  for (let f = 0; f < frames; f++) {
    const at = f * FRAME_VALUES;
    const x = values[at]!;
    const y = values[at + 1]!;
    if (Math.abs(x) > MOVE_RULES.maxRootXMm) return `frame ${f}: the body travels more than 6 m`;
    if (y < MOVE_RULES.minRootYMm || y > MOVE_RULES.maxRootYMm) return `frame ${f}: the body is too far below or above the floor`;
    if (f === 0) continue;
    const before = at - FRAME_VALUES;
    if (Math.hypot(x - values[before]!, y - values[before + 1]!) > MOVE_RULES.maxRootStepMm) return `frame ${f}: the body moves faster than 45 m/s`;
    for (let j = 2; j < FRAME_VALUES; j++) {
      // Angles wrap at half a turn, so the step is taken the short way round.
      const step = Math.abs((((values[at + j]! - values[before + j]!) + 32768) & 0xffff) - 32768);
      if (step > MOVE_RULES.maxJointStep) return `frame ${f}: the ${JOINTS[j - 2]} turns more than a third of a turn in one frame`;
    }
  }
  return null;
}
