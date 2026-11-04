/**
 * Photo arenas on this phone (IndexedDB), registered as arenas the game can fight in. Private by
 * default: nothing leaves the phone unless the player shares one with friends (AR-7), and there
 * is no public browser.
 *
 * Proposed contract (Integration PRD, launch):
 * - POST /arenas, multipart with `file` (the arena file, JSON) and `image` (the privacy-passed,
 *   ink-washed backdrop) → 201 { id, link }. The services may check and redraw it.
 * - GET /arenas/{id} → { file, imageUrl, palette } for a friend who opens the link (/a/{id}).
 */
import { parseArenaFile, type ArenaFile } from '@sticxcape/shared';
import * as db from '../app/db.ts';
import { services } from '../app/online.ts';
import { onDeleteMyData } from '../app/privacy.ts';
import { playerId } from '../app/social.ts';
import { registerArena, unregisterArena } from '../render/arenas.ts';
import { photoArenaArt } from '../render/photo-arena.ts';
import type { Palette } from './pipeline.ts';

export interface StoredArena {
  file: ArenaFile;
  /** The backdrop after the privacy pass and the ink restyle (JPEG). */
  image: Blob;
  palette: Palette;
  createdAt: number;
  /** The share link once shared with friends, else null. */
  shared: string | null;
}

type Listener = () => void;

class PhotoArenaStore {
  private items: StoredArena[] = [];
  private readonly listeners = new Set<Listener>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.load().catch(() => undefined);
    onDeleteMyData(() => this.clear());
  }

  private async load(): Promise<void> {
    const rows = await db.getAll<StoredArena>('arenas');
    const good = rows.filter((row) => parseArenaFile(row.file) && row.image instanceof Blob);
    for (const row of good) await this.register(row);
    this.items = good.sort((a, b) => b.createdAt - a.createdAt);
    this.emit();
  }

  private async register(row: StoredArena): Promise<boolean> {
    try {
      const bitmap = await createImageBitmap(row.image);
      registerArena(photoArenaArt(row.file, bitmap, row.palette));
      return true;
    } catch {
      return false;
    }
  }

  get list(): readonly StoredArena[] {
    return this.items;
  }

  get(id: string): StoredArena | undefined {
    return this.items.find((row) => row.file.id === id);
  }

  async save(row: StoredArena): Promise<void> {
    await this.register(row);
    this.items = [row, ...this.items.filter((other) => other.file.id !== row.file.id)];
    this.emit();
    await db.put('arenas', row);
  }

  async remove(id: string): Promise<void> {
    unregisterArena(id);
    this.items = this.items.filter((row) => row.file.id !== id);
    this.emit();
    await db.remove('arenas', id);
  }

  async clear(): Promise<void> {
    for (const row of this.items) unregisterArena(row.file.id);
    this.items = [];
    this.emit();
    await db.clear('arenas');
  }

  /** Shares an arena with friends: returns the link, or throws with a reason a player can read. */
  async share(id: string): Promise<string> {
    const row = this.get(id);
    if (!row) throw new Error('That arena isn’t on this phone any more.');
    if (row.shared) return row.shared;
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(row.file)], { type: 'application/json' }), 'arena.json');
    form.append('image', row.image, 'arena.jpg');
    form.append('palette', JSON.stringify(row.palette));
    let response: Response;
    try {
      response = await fetch(`${services.baseUrl}/arenas`, { method: 'POST', body: form, headers: { 'x-player-id': playerId() } });
    } catch {
      throw new Error('Couldn’t reach the game server. Your arena stays on this phone.');
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) throw new Error('Sharing photo arenas isn’t live on this server yet. Your arena stays on this phone.');
    if (!response.ok) {
      // The server says why it refused (a name or backdrop Muse Spark won't share, say) in words a player can read.
      const refusal = (await response.json().catch(() => null)) as { message?: unknown } | null;
      throw new Error(typeof refusal?.message === 'string' ? refusal.message : 'The server couldn’t take that arena. Try again later.');
    }
    const body = (await response.json()) as { link?: string; id?: string };
    const link = body.link ?? (body.id ? `${location.origin}/a/${body.id}` : null);
    if (!link) throw new Error('The server didn’t send a link back.');
    const next = { ...row, shared: link };
    this.items = this.items.map((other) => (other.file.id === id ? next : other));
    this.emit();
    await db.put('arenas', next);
    return link;
  }

  /** Adds an arena a friend shared (a /a/{id} link) to this phone. */
  async fetchShared(id: string): Promise<StoredArena> {
    const known = this.get(id);
    if (known) return known;
    let response: Response;
    try {
      response = await fetch(`${services.baseUrl}/arenas/${encodeURIComponent(id)}`);
    } catch {
      throw new Error('Couldn’t reach the game server to get that arena.');
    }
    if (!response.ok) throw new Error(response.status === 404 ? 'That arena isn’t shared any more, or sharing isn’t live on this server yet.' : 'That arena couldn’t be loaded.');
    const body = (await response.json()) as { file?: unknown; imageUrl?: string; palette?: Palette };
    const file = parseArenaFile(body.file);
    if (!file || !body.imageUrl || !body.palette) throw new Error('That arena couldn’t be read.');
    const image = await (await fetch(body.imageUrl)).blob();
    const row: StoredArena = { file, image, palette: body.palette, createdAt: Date.now(), shared: `${location.origin}/a/${file.id}` };
    await this.save(row);
    return row;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export const photoArenas = new PhotoArenaStore();
