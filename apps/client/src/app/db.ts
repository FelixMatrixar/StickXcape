/**
 * The game's IndexedDB on this phone: recorded moves and photo arenas. One place opens it, at
 * one version, so the stores never block each other's upgrades. When IndexedDB is unavailable
 * (some private modes), everything resolves to null and callers keep data in memory instead.
 */
const NAME = 'sticxcape';
const VERSION = 2;

export type StoreName = 'moves' | 'arenas';

let opening: Promise<IDBDatabase | null> | null = null;

export function openDb(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(NAME, VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('moves')) db.createObjectStore('moves', { keyPath: 'move.id' });
      if (!db.objectStoreNames.contains('arenas')) db.createObjectStore('arenas', { keyPath: 'file.id' });
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
  return opening;
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => resolve([]);
  });
}

function write(store: StoreName, act: (s: IDBObjectStore) => void): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve) => {
        if (!db) return resolve();
        const tx = db.transaction(store, 'readwrite');
        act(tx.objectStore(store));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      }),
  );
}

export function put(store: StoreName, value: unknown): Promise<void> {
  return write(store, (s) => s.put(value));
}

export function remove(store: StoreName, key: string): Promise<void> {
  return write(store, (s) => s.delete(key));
}

export function clear(store: StoreName): Promise<void> {
  return write(store, (s) => s.clear());
}
