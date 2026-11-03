import { ARENA_FORMAT_VERSION } from './constants.ts';
import { cleanText, isNum, isRecord, oneOf } from './validate.ts';

/** Official arena ids are short slugs; photo arenas (launch) use UUIDs, which also match. */
export const ARENA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const ARENA_EDGES = ['wall', 'drop'] as const;
export type ArenaEdge = (typeof ARENA_EDGES)[number];

export interface ArenaLedge {
  x: number;
  y: number;
  width: number;
}

/** Arena file, version 1 (Integration PRD). Distances are in metres. */
export interface ArenaFile {
  id: string;
  version: typeof ARENA_FORMAT_VERSION;
  name: string;
  /** Background and foreground art, back to front. */
  layers: string[];
  /** Height of the floor line above the bottom of the art. */
  floor: number;
  /** Playable width. */
  width: number;
  /** Where the two fighters start. */
  spawns: [number, number];
  /** Platforms (launch). */
  ledges: ArenaLedge[];
  /** Drops allow ring-outs (launch). */
  edges: { left: ArenaEdge; right: ArenaEdge };
}

export function isArenaId(value: unknown): value is string {
  return typeof value === 'string' && ARENA_ID_PATTERN.test(value);
}

/** Checks an arena file's structure and returns a copy holding only the contract's fields, or null. */
export function parseArenaFile(value: unknown): ArenaFile | null {
  if (!isRecord(value)) return null;
  const { id, version, layers, floor, width, spawns, ledges, edges } = value;
  const name = cleanText(value.name, 32);
  if (!isArenaId(id) || version !== ARENA_FORMAT_VERSION || name === null) return null;
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > 8) return null;
  if (!layers.every((layer) => typeof layer === 'string' && layer.length > 0 && layer.length <= 2048)) return null;
  if (!isNum(floor, 0, 20) || !isNum(width, 1, 100)) return null;
  if (!Array.isArray(spawns) || spawns.length !== 2) return null;
  const [left, right] = spawns as unknown[];
  if (!isNum(left, 0, width) || !isNum(right, left, width)) return null;
  if (!Array.isArray(ledges) || ledges.length > 32) return null;
  const cleanLedges: ArenaLedge[] = [];
  for (const ledge of ledges) {
    if (!isRecord(ledge) || !isNum(ledge.x, 0, width) || !isNum(ledge.y, 0, 20) || !isNum(ledge.width, 0.1, width)) return null;
    cleanLedges.push({ x: ledge.x, y: ledge.y, width: ledge.width });
  }
  if (!isRecord(edges) || !oneOf(ARENA_EDGES, edges.left) || !oneOf(ARENA_EDGES, edges.right)) return null;

  return {
    id,
    version: ARENA_FORMAT_VERSION,
    name,
    layers: layers as string[],
    floor,
    width,
    spawns: [left, right],
    ledges: cleanLedges,
    edges: { left: edges.left, right: edges.right },
  };
}
