import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { block, flushReports, isBlocked, queued, report, unblock } from '../src/app/social.ts';

/** A tiny in-memory localStorage. */
function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
}

describe('report and block', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeStorage());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks by nickname, ignoring case and spaces, and unblocks', () => {
    block('Doodle Bot');
    expect(isBlocked('doodle bot ')).toBe(true);
    unblock('DOODLE BOT');
    expect(isBlocked('Doodle Bot')).toBe(false);
  });

  it('keeps a report on the phone when the server can’t take it, and sends it later', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetch);
    expect(await report('Sketch Ghost', 'name', 'abcd1234abcd1234')).toBe('queued');
    expect(queued()).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/reports$/), expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ nickname: 'Sketch Ghost', reason: 'name', room: 'abcd1234abcd1234' });

    // The server comes up: the waiting report goes out and leaves the queue.
    fetch.mockResolvedValue({ ok: true, status: 202 });
    expect(await flushReports()).toBe(1);
    expect(queued()).toHaveLength(0);
  });

  it('sends straight away when it can', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }));
    expect(await report('Sketch Ghost', 'cheating', null)).toBe('sent');
    expect(queued()).toHaveLength(0);
  });
});
