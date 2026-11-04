import type { MoveFile, MoveSlot } from '@sticxcape/shared';
import { defaultMoves } from './defaults.ts';

/** The nine loadout places, in the order a loadout is sent and the engine reads it. */
export const LOADOUT_KEYS = [
  { key: 'light1', slot: 'light', label: 'Light', input: 'L' },
  { key: 'light2', slot: 'light', label: 'Light 2', input: '◀▶ + L' },
  { key: 'heavy1', slot: 'heavy', label: 'Heavy', input: 'H' },
  { key: 'heavy2', slot: 'heavy', label: 'Heavy 2', input: '◀▶ + H' },
  { key: 'low', slot: 'low', label: 'Low', input: '▼ + H' },
  { key: 'special', slot: 'special', label: 'Special', input: 'S' },
  { key: 'defense', slot: 'defense', label: 'Defense', input: 'D' },
  { key: 'taunt', slot: 'taunt', label: 'Taunt', input: '▼ + D' },
  { key: 'victory', slot: 'victory', label: 'Victory', input: 'On a win' },
] as const satisfies readonly { key: string; slot: MoveSlot; label: string; input: string }[];

export type LoadoutKey = (typeof LOADOUT_KEYS)[number]['key'];
export type LoadoutSelection = Partial<Record<LoadoutKey, string>>;

/** The four moves new players record first (MVP): light, heavy, low and special. */
export const STARTER_KEYS: readonly LoadoutKey[] = ['light1', 'heavy1', 'low', 'special'];

/**
 * A full nine-move loadout: the player's choice for each place, or the default move. A move
 * appears at most once (the relay rejects duplicate ids), and each must match its place's slot.
 */
export function buildLoadout(selection: LoadoutSelection, library: readonly MoveFile[]): MoveFile[] {
  const defaults = defaultMoves();
  const byId = new Map(library.map((move) => [move.id, move]));
  const used = new Set<string>();
  return LOADOUT_KEYS.map(({ key, slot }, i) => {
    const chosen = selection[key] ? byId.get(selection[key]!) : undefined;
    let move = chosen && chosen.slot === slot && !used.has(chosen.id) ? chosen : defaults[i];
    // Two places of one slot can't share a move: fall back to an unused default of that slot.
    if (used.has(move.id)) move = defaults.find((d) => d.slot === slot && !used.has(d.id)) ?? move;
    used.add(move.id);
    return move;
  });
}

/** Fills a loadout from the relay to nine moves with defaults, keeping the sender's order. */
export function completeLoadout(moves: readonly MoveFile[]): MoveFile[] {
  const defaults = defaultMoves();
  const out: MoveFile[] = [];
  const used = new Set<string>();
  const bySlot = new Map<MoveSlot, MoveFile[]>();
  for (const move of moves) {
    const list = bySlot.get(move.slot) ?? [];
    list.push(move);
    bySlot.set(move.slot, list);
  }
  LOADOUT_KEYS.forEach(({ slot }, i) => {
    const list = bySlot.get(slot);
    const move = list && list.length > 0 ? list.shift()! : defaults[i];
    if (used.has(move.id)) return;
    used.add(move.id);
    out.push(move);
  });
  return out;
}
