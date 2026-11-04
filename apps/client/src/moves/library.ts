/**
 * The move library on the phone (IndexedDB). Recorded moves stay in this browser; Safari can
 * clear a site's storage after about a week without a visit, which is why the home screen asks
 * iPhone players to add the app to their home screen. When IndexedDB is unavailable (some
 * private modes), moves live in memory for the visit.
 */
import { parseMoveFile, type MoveFile } from '@sticxcape/shared';

export interface StoredMove {
  move: MoveFile;
  createdAt: number;
  description: string | null;
  /** How clean the capture was, 0..1 (higher is smoother). */
  quality: number | null;
}

const DB = 'sticxcape';
const STORE = 'moves';

type Listener = () => void;

class MoveLibrary {
  private items: StoredMove[] = [];
  private db: IDBDatabase | null = null;
  private readonly listeners = new Set<Listener>();
  readonly ready: Promise<void>;
  persistent = false;

  constructor() {
    this.ready = this.open().catch(() => undefined);
  }

  private open(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve();
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB, 1);
      } catch {
        return resolve();
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'move.id' });
      };
      request.onerror = () => resolve();
      request.onsuccess = () => {
        this.db = request.result;
        this.persistent = true;
        const tx = this.db.transaction(STORE, 'readonly');
        const all = tx.objectStore(STORE).getAll();
        all.onsuccess = () => {
          const rows = (all.result as StoredMove[]).filter((row) => parseMoveFile(row.move) !== null);
          this.items = rows.sort((a, b) => b.createdAt - a.createdAt);
          resolve();
          this.emit();
        };
        all.onerror = () => resolve();
      };
    });
  }

  get moves(): readonly StoredMove[] {
    return this.items;
  }

  files(): MoveFile[] {
    return this.items.map((item) => item.move);
  }

  get(id: string): StoredMove | undefined {
    return this.items.find((item) => item.move.id === id);
  }

  async save(item: StoredMove): Promise<void> {
    this.items = [item, ...this.items.filter((other) => other.move.id !== item.move.id)];
    this.emit();
    if (!this.db) return;
    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter((item) => item.move.id !== id);
    this.emit();
    if (!this.db) return;
    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
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
