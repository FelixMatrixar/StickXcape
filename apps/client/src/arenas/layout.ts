/**
 * Making a photo playable (the pipeline's "make it playable" and "check" steps): the floor line
 * becomes the fight line, furniture standing on it becomes ledges at a height you can jump to,
 * spawns stay clear, and photos with too little floor are turned down. Pure rules, so they run in
 * tests and on the phone the same way.
 */
import { ARENA_FORMAT_VERSION, type ArenaFile, type ArenaLedge } from '@sticxcape/shared';

/** A detected object, in image coordinates (0..1 of the width and height). */
export interface FoundBox {
  label: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PhotoLayout {
  /** Where the fight line runs, from the top of the photo (0..1). */
  floorY: number;
  ledges: ArenaLedge[];
  edges: ArenaFile['edges'];
  spawns: [number, number];
}

/** The arena is 10 m wide; the backdrop photo spans this many metres at its depth. */
export const ART_WIDTH = 18;
const WIDTH = 10;
const SPAWNS: [number, number] = [3.6, 6.4];
/** Furniture you can stand on, and the height of what you'd stand on (metres). */
const LEDGE_HEIGHTS: Readonly<Record<string, number>> = {
  couch: 0.45,
  bed: 0.5,
  bench: 0.45,
  chair: 0.45,
  'dining table': 0.75,
};
/** Within this much (of the photo's height) of the fight line, furniture counts as on it. */
const ON_THE_LINE = 0.12;
const MIN_LEDGE = 0.9;
const MAX_LEDGE = 2.2;
const MAX_LEDGES = 2;

/** A first guess at the fight line: where the nearest furniture meets the floor, else low in the frame. */
export function estimateFloor(found: readonly FoundBox[]): number {
  const bases = found
    .filter((b) => b.label in LEDGE_HEIGHTS && b.y1 > 0.5 && b.y1 < 0.95)
    .map((b) => b.y1)
    .sort((a, b) => b - a);
  return clamp(bases[0] ?? 0.8, 0.55, 0.92);
}

/** Furniture standing on the fight line becomes ledges, kept clear of the spawns and each other. */
export function ledgesFrom(found: readonly FoundBox[], floorY: number): ArenaLedge[] {
  const candidates = found
    .filter((b) => b.label in LEDGE_HEIGHTS && Math.abs(b.y1 - floorY) <= ON_THE_LINE)
    .map((b) => {
      // The photo's width runs across the arena with a metre to spare each side.
      const centre = clamp(-1 + ((b.x0 + b.x1) / 2) * (WIDTH + 2), 0.8, WIDTH - 0.8);
      const width = clamp((b.x1 - b.x0) * (WIDTH + 2), MIN_LEDGE, MAX_LEDGE);
      const x = clamp(centre - width / 2, 0.4, WIDTH - 0.4 - width);
      return { x: round(x), y: LEDGE_HEIGHTS[b.label], width: round(width), size: b.x1 - b.x0 };
    })
    .sort((a, b) => b.size - a.size);
  const kept: ArenaLedge[] = [];
  for (const c of candidates) {
    if (kept.length >= MAX_LEDGES) break;
    const blocksSpawn = SPAWNS.some((s) => c.x < s + 0.6 && c.x + c.width > s - 0.6);
    const overlaps = kept.some((k) => c.x < k.x + k.width + 1.2 && c.x + c.width + 1.2 > k.x);
    if (!blocksSpawn && !overlaps) kept.push({ x: c.x, y: c.y, width: c.width });
  }
  return kept.sort((a, b) => a.x - b.x);
}

/** A reason to ask for another photo, or null when this one will play. */
export function checkPhoto(width: number, height: number, floorY: number, light: number): string | null {
  if (width < height) return 'Turn your phone sideways: a wide shot of the room works best.';
  if (light < 28) return 'That photo is too dark to read. Turn on a light and try again.';
  if (floorY < 0.5) return 'The floor barely shows. Stand further back so more floor is in the shot.';
  return null;
}

export function layoutFor(found: readonly FoundBox[], floorY = estimateFloor(found)): PhotoLayout {
  return { floorY, ledges: ledgesFrom(found, floorY), edges: { left: 'wall', right: 'wall' }, spawns: [...SPAWNS] };
}

/** The arena file (Integration PRD, version 1). `floor` is the fight line's height above the art's bottom, in metres. */
export function arenaFileFor(id: string, name: string, layout: PhotoLayout, aspect: number): ArenaFile {
  const artHeight = ART_WIDTH / aspect;
  return {
    id,
    version: ARENA_FORMAT_VERSION,
    name,
    layers: [`photo:${id}`],
    floor: round((1 - layout.floorY) * artHeight),
    width: WIDTH,
    spawns: layout.spawns,
    ledges: layout.ledges,
    edges: layout.edges,
  };
}

/** Back from the file to where the fight line sits in the photo. */
export function floorYOf(file: ArenaFile, aspect: number): number {
  return clamp(1 - file.floor / (ART_WIDTH / aspect), 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
