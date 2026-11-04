/**
 * The move library on the phone (IndexedDB). Recorded moves stay in this browser; Safari can
 * clear a site's storage after about a week without a visit, which is why the home screen asks
 * iPhone players to add the app to their home screen, and why moves can be backed up to a file
 * or synced to the cloud library. When IndexedDB is unavailable (some private modes), moves live
 * in memory for the visit.
 */
import { parseMoveFile, type MoveFile } from '@sticxcape/shared';
import * as db from '../app/db.ts';

export interface StoredMove {
  move: MoveFile;
  createdAt: number;
  description: string | null;
  /** How clean the capture was, 0..1 (higher is smoother). */
  quality: number | null;
  /** An idle stance (LS-12) is kept here too, but never offered as a fighting move. */
  kind?: 'move' | 'idle';
}

type Listener = () => void;

class MoveLibrary {
  private items: StoredMove[] = [];
  private readonly listeners = new Set<Listener>();
  readonly ready: Promise<void>;
  persistent = false;

  constructor() {
    this.ready = this.open().catch(() => undefined);
  }

  private async open(): Promise<void> {
    this.persistent = (await db.openDb()) !== null;
    const rows = (await db.getAll<StoredMove>('moves')).filter((row) => parseMoveFile(row.move) !== null);
    this.items = rows.sort((a, b) => b.createdAt - a.createdAt);
    this.emit();
  }

  get moves(): readonly StoredMove[] {
    return this.items;
  }

  /** Fighting moves only; idle stances are left out. */
  files(): MoveFile[] {
    return this.items.filter((item) => item.kind !== 'idle').map((item) => item.move);
  }

  get(id: string): StoredMove | undefined {
    return this.items.find((item) => item.move.id === id);
  }

  async save(item: StoredMove): Promise<void> {
    this.items = [item, ...this.items.filter((other) => other.move.id !== item.move.id)].sort((a, b) => b.createdAt - a.createdAt);
    this.emit();
    await db.put('moves', item);
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((item) => item.move.id !== id);
    this.emit();
    await db.remove('moves', id);
  }

  /** Deletes every recorded move and idle stance on this phone. */
  async clear(): Promise<void> {
    this.items = [];
    this.emit();
    await db.clear('moves');
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const library = new MoveLibrary();
