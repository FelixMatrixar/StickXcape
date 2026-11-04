/**
 * The official arenas as arena files (Integration PRD, arena file version 1). Kept apart from the
 * painting code so anything that builds a simulation (the game, the title screen, the Node bot
 * opponent) reads the same width, spawns and edges: a mismatch would desync an online match.
 */
import { ARENA_FORMAT_VERSION, type ArenaFile } from '@sticxcape/shared';
import type { SimArena } from '../engine/sim.ts';

function arenaFile(id: string, name: string, edges: ArenaFile['edges'], ledges: ArenaFile['ledges'] = []): ArenaFile {
  return {
    id,
    version: ARENA_FORMAT_VERSION,
    name,
    layers: [`builtin:${id}`],
    floor: 0,
    width: 10,
    spawns: [3.6, 6.4],
    ledges,
    edges,
  };
}

export const ARENA_FILES: Readonly<Record<string, ArenaFile>> = {
  // The roof just ends: a hit near either edge can knock someone off (ring-out). An air-conditioning
  // unit near each end is a ledge (AR-6): high ground, and a guard rail you can be launched over.
  rooftop: arenaFile('rooftop', 'Rooftop at Dusk', { left: 'drop', right: 'drop' }, [
    { x: 1.0, y: 0.55, width: 1.1 },
    { x: 7.9, y: 0.55, width: 1.1 },
  ]),
  dojo: arenaFile('dojo', 'Bamboo Dojo', { left: 'wall', right: 'wall' }),
};

export function arenaFileById(id: string | null | undefined): ArenaFile {
  return ARENA_FILES[id ?? ''] ?? ARENA_FILES.rooftop;
}

/** What the simulation needs from an arena file. */
export function simArena(file: ArenaFile): SimArena {
  return { width: file.width, spawns: file.spawns, edges: file.edges, ledges: file.ledges };
}
