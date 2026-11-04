import { describe, expect, it, vi } from 'vitest';
import { settings } from '../src/app/settings.ts';
import { backup, deleteMyData, onDeleteMyData, restoreBackup } from '../src/app/privacy.ts';
import { defaultMoves } from '../src/moves/defaults.ts';
import { uuid, withHashSync } from '../src/moves/hash.ts';
import { library } from '../src/moves/library.ts';

function recorded(name: string) {
  const base = defaultMoves()[0];
  return withHashSync({ ...base, id: uuid(), name });
}

describe('your data (privacy)', () => {
  it('restores checked moves from a backup and skips tampered ones', async () => {
    await library.ready;
    const good = recorded('Thunder Jab');
    const tampered = { ...recorded('Sneaky Jab'), name: 'Changed After Hashing' };
    const file = {
      kind: 'sticxcape.moves',
      version: 1,
      exportedAt: new Date().toISOString(),
      moves: [
        { move: good, createdAt: 1, description: null, quality: 0.9, kind: 'move' },
        { move: tampered, createdAt: 2, description: null, quality: 0.9, kind: 'move' },
      ],
      loadout: { light: good.id },
      idleStance: null,
    };
    expect(await restoreBackup(JSON.stringify(file))).toBe(1);
    expect(library.get(good.id)?.move.name).toBe('Thunder Jab');
    expect(library.get(tampered.id)).toBeUndefined();
    expect(settings.loadout.light).toBe(good.id);
    // Restoring again adds nothing; a backup round-trips.
    expect(await restoreBackup(JSON.stringify(file))).toBe(0);
    expect(backup().moves.some((m) => m.move.id === good.id)).toBe(true);
  });

  it('refuses a file that is not a backup', async () => {
    await expect(restoreBackup('{"hello":1}')).rejects.toThrow('isn’t a SticXcape backup');
    await expect(restoreBackup('not json')).rejects.toThrow();
  });

  it('deletes every move and runs each feature’s own cleanup', async () => {
    await library.save({ move: recorded('Gone Soon'), createdAt: 3, description: null, quality: null });
    const cleanup = vi.fn();
    onDeleteMyData(cleanup);
    await deleteMyData();
    expect(library.moves).toHaveLength(0);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
