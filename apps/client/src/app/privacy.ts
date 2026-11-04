/**
 * The player's data on this phone (privacy: skeletons are sensitive and are deleted on request).
 * Delete everything, or back moves up to a file and restore them, so moves can survive a
 * cleared browser even before signing in to the cloud library.
 */
import { parseMoveFile } from '@sticxcape/shared';
import { moveHash } from '../moves/hash.ts';
import { library, type StoredMove } from '../moves/library.ts';
import { LOADOUT_KEYS } from '../moves/loadout.ts';
import { settings, updateSettings } from './settings.ts';

type Cleanup = () => Promise<void> | void;
const cleanups: Cleanup[] = [];

/** Lets a feature (photo arenas, the account) wipe its own data when the player deletes theirs. */
export function onDeleteMyData(cleanup: Cleanup): void {
  cleanups.push(cleanup);
}

/** Deletes every recorded move, stance, photo arena and setting on this phone, then starts over. */
export async function deleteMyData(): Promise<void> {
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch {
      // Keep going: the rest still gets deleted.
    }
  }
  await library.clear();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('sticxcape')) localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing was saved there anyway.
  }
}

export interface MovesBackup {
  kind: 'sticxcape.moves';
  version: 1;
  exportedAt: string;
  moves: StoredMove[];
  loadout: typeof settings.loadout;
  idleStance: string | null;
}

/** Every recorded move and stance, with the loadout that uses them. */
export function backup(): MovesBackup {
  return {
    kind: 'sticxcape.moves',
    version: 1,
    exportedAt: new Date().toISOString(),
    moves: [...library.moves],
    loadout: { ...settings.loadout },
    idleStance: settings.idleStance,
  };
}

/** Saves the backup as a file through the browser's own download. */
export function downloadBackup(): number {
  const data = backup();
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sticxcape-moves-${data.exportedAt.slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return data.moves.length;
}

/**
 * Restores moves from a backup. Every move is checked (format and hash) first; moves already on
 * this phone are kept as they are. Returns how many were added, or throws with a plain reason.
 */
export async function restoreBackup(text: string): Promise<number> {
  let data: Partial<MovesBackup>;
  try {
    data = JSON.parse(text) as Partial<MovesBackup>;
  } catch {
    throw new Error('That file isn’t a SticXcape backup.');
  }
  if (data.kind !== 'sticxcape.moves' || data.version !== 1 || !Array.isArray(data.moves)) throw new Error('That file isn’t a SticXcape backup.');
  let added = 0;
  for (const item of data.moves) {
    const move = parseMoveFile(item?.move);
    // The client's own SHA-256: crypto.subtle is missing on plain-http test builds.
    if (!move || moveHash(move) !== move.hash) continue;
    if (library.get(move.id)) continue;
    await library.save({ move, createdAt: Number(item.createdAt) || Date.now(), description: typeof item.description === 'string' ? item.description : null, quality: typeof item.quality === 'number' ? item.quality : null, kind: item.kind === 'idle' ? 'idle' : 'move' });
    added += 1;
  }
  // Put the loadout back where its moves are now on this phone (known places only).
  const loadout = { ...settings.loadout };
  const places = new Set<string>(LOADOUT_KEYS.map((k) => k.key));
  for (const [key, id] of Object.entries(data.loadout ?? {})) {
    if (places.has(key) && typeof id === 'string' && library.get(id)) (loadout as Record<string, string>)[key] = id;
  }
  const idle = typeof data.idleStance === 'string' && library.get(data.idleStance)?.kind === 'idle' ? data.idleStance : settings.idleStance;
  updateSettings({ loadout, idleStance: idle });
  return added;
}
