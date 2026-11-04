import { describe, expect, it } from 'vitest';
import {
  Button,
  BUTTONS_MASK,
  cleanButtons,
  cleanText,
  encodeFrames,
  FRAME_VALUES,
  inputDelayForPing,
  isButtons,
  isHashFrame,
  isRoomCode,
  KEYFRAME_MAX_CHARS,
  decodeBase64Url,
  encodeBase64Url,
  parseAccountName,
  parseArenaPalette,
  parseRoomReport,
  photoArenaLayer,
  isPhotoArenaId,
  parseCloudMove,
  parseLoadoutSelection,
  parsePasskeyAssertion,
  parsePasskeyRegistration,
  MAX_ROLLBACK_FRAMES,
  moveRuleProblem,
  mirrorButtons,
  MOVE_FORMAT_VERSION,
  packButtons,
  parseClientMessage,
  parseMatchTipsRequest,
  parseMoveNameRequest,
  parseServerMessage,
  rollbackInputDelayForPing,
  ROLLBACK_INPUT_DELAY,
  roomCodeFromPath,
  roomLink,
  unpackButtons,
  withHash,
} from '@sticxcape/shared';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const WEBP = 'data:image/webp;base64,UklGRg==';

describe('buttons', () => {
  it('packs into 9 bits and unpacks again', () => {
    const buttons = packButtons({ Up: true, Heavy: true, Block: true });
    expect(buttons).toBe(Button.Up | Button.Heavy | Button.Block);
    expect(unpackButtons(buttons)).toMatchObject({ Up: true, Heavy: true, Block: true, Down: false, Light: false });
    expect(BUTTONS_MASK).toBe(0b1_1111_1111);
  });

  it('cancels opposite stick directions', () => {
    expect(packButtons({ Left: true, Right: true, Light: true })).toBe(Button.Light);
    expect(cleanButtons(Button.Up | Button.Down | Button.Right)).toBe(Button.Right);
    expect(cleanButtons(0xffff)).toBe(BUTTONS_MASK & ~(Button.Up | Button.Down | Button.Left | Button.Right));
  });

  it('mirrors left and right only', () => {
    expect(mirrorButtons(Button.Left | Button.Special)).toBe(Button.Right | Button.Special);
    expect(mirrorButtons(Button.Right | Button.Up)).toBe(Button.Left | Button.Up);
    expect(mirrorButtons(Button.Defense)).toBe(Button.Defense);
  });

  it('accepts only whole numbers inside the field', () => {
    expect(isButtons(0)).toBe(true);
    expect(isButtons(BUTTONS_MASK)).toBe(true);
    expect(isButtons(BUTTONS_MASK + 1)).toBe(false);
    expect(isButtons(-1)).toBe(false);
    expect(isButtons(1.5)).toBe(false);
    expect(isButtons('1')).toBe(false);
  });
});

describe('input delay rule', () => {
  it('is 3 frames under 80 ms and grows to at most 6', () => {
    expect(inputDelayForPing(0)).toBe(3);
    expect(inputDelayForPing(79)).toBe(3);
    expect(inputDelayForPing(80)).toBe(4);
    expect(inputDelayForPing(120)).toBe(5);
    expect(inputDelayForPing(150)).toBe(6);
    expect(inputDelayForPing(1000)).toBe(6);
  });

  it('assumes the worst for a ping it cannot read', () => {
    expect(inputDelayForPing(Number.NaN)).toBe(6);
    expect(inputDelayForPing(-5)).toBe(6);
    expect(rollbackInputDelayForPing(Number.NaN)).toBe(6);
  });

  it('keeps rollback matches at 2 frames until a phone would rewind more than 8', () => {
    expect([ROLLBACK_INPUT_DELAY, MAX_ROLLBACK_FRAMES]).toEqual([2, 8]);
    expect(rollbackInputDelayForPing(0)).toBe(2);
    expect(rollbackInputDelayForPing(100)).toBe(2);
    // The opponent's inputs arrive 8 frames late (one way, plus 2 for jitter) at about 260 ms.
    expect(rollbackInputDelayForPing(266)).toBe(2);
    expect(rollbackInputDelayForPing(300)).toBe(3);
    expect(rollbackInputDelayForPing(400)).toBe(6);
    expect(rollbackInputDelayForPing(1000)).toBe(6);
  });

  it('hashes every 60 frames from frame 0', () => {
    expect([0, 59, 60, 61, 120].map(isHashFrame)).toEqual([true, false, true, false, true]);
  });
});

describe('room codes and links', () => {
  it('accepts 16 characters of lowercase Crockford base32', () => {
    expect(isRoomCode('0123456789abcdef')).toBe(true);
    expect(isRoomCode('0123456789abcdeF')).toBe(false);
    expect(isRoomCode('0123456789abcdei')).toBe(false);
    expect(isRoomCode('0123456789abcdeu')).toBe(false);
    expect(isRoomCode('0123456789abcde')).toBe(false);
  });

  it('builds invite links and reads the code back from the path', () => {
    expect(roomLink('https://play.example/', 'hjkmnpqrstvwxyz0')).toBe('https://play.example/r/hjkmnpqrstvwxyz0');
    expect(roomCodeFromPath('/r/HJKMNPQRSTVWXYZ0')).toBe('hjkmnpqrstvwxyz0');
    expect(roomCodeFromPath('/r/hjkmnpqrstvwxyz0/')).toBe('hjkmnpqrstvwxyz0');
    expect(roomCodeFromPath('/r/short')).toBeNull();
    expect(roomCodeFromPath('/x/hjkmnpqrstvwxyz0')).toBeNull();
  });
});

describe('cleanText', () => {
  it('normalizes spaces and Unicode', () => {
    expect(cleanText('  Ana   the\tGreat ', 16)).toBe('Ana the Great');
    expect(cleanText('José', 16)).toBe('José');
  });

  it('counts characters, not UTF-16 units', () => {
    expect(cleanText('🥊'.repeat(16), 16)).toBe('🥊'.repeat(16));
    expect(cleanText('🥊'.repeat(17), 16)).toBeNull();
  });

  it('refuses empty text, hidden characters and non-strings', () => {
    expect(cleanText('   ', 16)).toBeNull();
    expect(cleanText('Ana​Bo', 16)).toBeNull();
    expect(cleanText('Ana‮Bo', 16)).toBeNull();
    expect(cleanText(42, 16)).toBeNull();
  });
});

async function sampleMove() {
  return withHash({
    id: '3b0c1a52-7d1e-4a4b-9e43-0c6b8f2d9a10',
    version: MOVE_FORMAT_VERSION,
    slot: 'light',
    name: 'Quick Jab',
    frames: encodeFrames(new Int16Array(FRAME_VALUES * 4)),
    active: [1, 2],
    limb: 'rightWrist',
    height: 'mid',
  });
}

describe('parseClientMessage', () => {
  const parse = (value: unknown) => parseClientMessage(typeof value === 'string' ? value : JSON.stringify(value));

  it('drops text that is not a JSON object', () => {
    expect(parse('not json')).toBeNull();
    expect(parse('[]')).toBeNull();
    expect(parse('null')).toBeNull();
    expect(parse({ type: 'teleport' })).toBeNull();
  });

  it('checks inputs and hashes', () => {
    expect(parse({ type: 'input', frame: 3, buttons: Button.Light, extra: true })).toEqual({ type: 'input', frame: 3, buttons: Button.Light });
    expect(parse({ type: 'input', frame: -1, buttons: 0 })).toBeNull();
    expect(parse({ type: 'input', frame: 1.5, buttons: 0 })).toBeNull();
    expect(parse({ type: 'input', frame: 3, buttons: BUTTONS_MASK + 1 })).toBeNull();
    expect(parse({ type: 'hash', frame: 60, stateHash: 0xffffffff })).toEqual({ type: 'hash', frame: 60, stateHash: 0xffffffff });
    expect(parse({ type: 'hash', frame: 60, stateHash: 0x100000000 })).toBeNull();
    expect(parse({ type: 'hash', frame: 60, stateHash: -1 })).toBeNull();
  });

  it('shape-checks join but leaves nickname rules to the relay', () => {
    expect(parse({ type: 'join', room: 'abc', nickname: ' ', clientVersion: 1 })).toEqual({ type: 'join', room: 'abc', nickname: ' ', clientVersion: 1 });
    expect(parse({ type: 'join', room: 'a'.repeat(65), nickname: 'Ana', clientVersion: 1 })).toBeNull();
    expect(parse({ type: 'join', room: 'abc', nickname: 'a'.repeat(257), clientVersion: 1 })).toBeNull();
    expect(parse({ type: 'join', room: 'abc', nickname: 'Ana', clientVersion: '1' })).toBeNull();
  });

  it('checks the lobby messages', async () => {
    expect(parse({ type: 'ready', anything: 1 })).toEqual({ type: 'ready' });
    expect(parse({ type: 'ready', rollback: true })).toEqual({ type: 'ready', rollback: true });
    expect(parse({ type: 'ready', rollback: 'yes' })).toEqual({ type: 'ready' });
    expect(parse({ type: 'sync', lateness: -2.5 })).toEqual({ type: 'sync', lateness: -2.5 });
    expect(parse({ type: 'sync', lateness: 601 })).toBeNull();
    expect(parse({ type: 'sync', lateness: '1' })).toBeNull();
    expect(parse({ type: 'quickmatch', nickname: 'Ana' })).toEqual({ type: 'quickmatch', nickname: 'Ana' });
    expect(parse({ type: 'quickmatch' })).toBeNull();
    expect(parse({ type: 'cancelmatch', extra: 1 })).toEqual({ type: 'cancelmatch' });
    expect(parse({ type: 'leave' })).toEqual({ type: 'leave' });
    expect(parse({ type: 'arena', arenaId: 'rooftop-2' })).toEqual({ type: 'arena', arenaId: 'rooftop-2' });
    expect(parse({ type: 'arena', arenaId: 'Rooftop' })).toBeNull();
    expect(parse({ type: 'end', winner: null })).toEqual({ type: 'end', winner: null });
    expect(parse({ type: 'end', winner: 8 })).toEqual({ type: 'end', winner: 8 });
    expect(parse({ type: 'end', winner: 9 })).toBeNull();
    expect(parse({ type: 'end', winner: 0 })).toBeNull();
    expect(parse({ type: 'ping', time: 12.5 })).toEqual({ type: 'ping', time: 12.5 });
    expect(parse({ type: 'pong', time: -1 })).toBeNull();

    const move = await sampleMove();
    expect(parse({ type: 'loadout', moves: [move] })).toEqual({ type: 'loadout', moves: [move] });
    expect(parse({ type: 'loadout', moves: [] })).toBeNull();
  });
});

describe('shared photo arenas and room reports', () => {
  it('takes palettes of rgb() or hex colours only', () => {
    const palette = { sky: 'rgb(1, 2, 3)', skyLow: 'rgb(255,255,255)', floorTop: '#a0B1c2', floorBottom: 'rgb(0, 0, 0)', ledge: 'rgb(9, 9, 9)', ledgeTop: 'rgb(10, 20, 30)' };
    expect(parseArenaPalette({ ...palette, extra: 'x' })).toEqual(palette);
    for (const sky of ['red', 'rgb(256, 0, 0)', 'url(https://a.example)', '#abc', 'rgba(1, 2, 3, 0.5)']) {
      expect(parseArenaPalette({ ...palette, sky }), sky).toBeNull();
    }
    expect(parseArenaPalette({ ...palette, ledgeTop: undefined })).toBeNull();
    expect(photoArenaLayer('abc')).toBe('photo:abc');
  });

  it('tells photo arenas (UUIDs) from built-in ones (short names)', () => {
    expect(isPhotoArenaId('7a1c0de0-0000-4000-8000-0000000000aa')).toBe(true);
    for (const id of ['rooftop', 'dojo', 'rooftop-2', '7A1C0DE0-0000-4000-8000-0000000000AA']) expect(isPhotoArenaId(id), id).toBe(false);
  });

  it('checks reports from friend rooms', () => {
    const report = { nickname: ' Bo ', reason: 'name', room: '0123456789ABCDEF', at: '2026-11-05T09:00:00Z' };
    expect(parseRoomReport(report)).toEqual({ nickname: 'Bo', reason: 'name', room: '0123456789abcdef', at: '2026-11-05T09:00:00Z' });
    expect(parseRoomReport({ ...report, room: null })).toMatchObject({ room: null });
    expect(parseRoomReport({ ...report, room: undefined })).toMatchObject({ room: null });
    for (const bad of [{ ...report, reason: 'nickname' }, { ...report, at: 'soon' }, { ...report, room: 'a/b' }, { ...report, nickname: 'x'.repeat(17) }]) {
      expect(parseRoomReport(bad)).toBeNull();
    }
  });
});

describe('move rules for signing', () => {
  /** A still move of `frames` frames, standing, with a change applied to its values. */
  function moveWith(frames: number, change: (values: Int16Array) => void = () => {}) {
    const values = new Int16Array(frames * FRAME_VALUES);
    for (let f = 0; f < frames; f++) values[f * FRAME_VALUES + 1] = 950;
    change(values);
    return withHash({
      id: '7a1c0de0-0000-4000-8000-000000000001',
      version: MOVE_FORMAT_VERSION,
      slot: 'light',
      name: 'Test',
      frames: encodeFrames(values),
      active: [0, frames - 1],
      limb: 'rightWrist',
      height: 'mid',
    });
  }

  it('passes ordinary moves, including a half-turn spin spread over frames and a wrap past half a turn', async () => {
    expect(moveRuleProblem(await moveWith(10))).toBeNull();
    expect(moveRuleProblem(await moveWith(10, (v) => v.forEach((_, i) => i % FRAME_VALUES === 2 && (v[i] = ((i / FRAME_VALUES) * 3600) | 0))))).toBeNull();
    // 179° to -179° is a 2° turn the short way round.
    expect(moveRuleProblem(await moveWith(2, (v) => ((v[4] = 32_600), (v[FRAME_VALUES + 4] = -32_600))))).toBeNull();
  });

  it('refuses teleports, limbs that spin round in a frame, and bodies far from the floor', async () => {
    expect(moveRuleProblem(await moveWith(3, (v) => (v[2 * FRAME_VALUES] = 800)))).toMatch(/frame 2.*45 m\/s/);
    expect(moveRuleProblem(await moveWith(3, (v) => (v[FRAME_VALUES + 2 + 7] = 22_000)))).toMatch(/frame 1: the rightElbow/);
    expect(moveRuleProblem(await moveWith(3, (v) => v.forEach((_, i) => i % FRAME_VALUES === 1 && (v[i] = 3100))))).toMatch(/floor/);
    expect(moveRuleProblem(await moveWith(3, (v) => v.forEach((_, i) => i % FRAME_VALUES === 0 && (v[i] = -6500))))).toMatch(/6 m/);
  });
});

describe('accounts and the cloud library', () => {
  it('encodes base64url without padding and decodes it strictly', () => {
    expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(encodeBase64Url(new Uint8Array([]))).toBe('');
    expect(decodeBase64Url('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(decodeBase64Url('-_8=')).toEqual(new Uint8Array([0xfb, 0xff]));
    for (const bad of ['+/8', 'A', 'AB=C', 'A*B']) expect(decodeBase64Url(bad), bad).toBeNull();
    const all = new Uint8Array(256).map((_, i) => i);
    expect(decodeBase64Url(encodeBase64Url(all))).toEqual(all);
  });

  it('checks account names, cloud moves and loadouts', async () => {
    expect(parseAccountName('  Ana  ')).toBe('Ana');
    expect(parseAccountName('')).toBeNull();
    const move = await sampleMove();
    const input = { move, kind: 'idle', description: '  A  stance ', quality: 0.5, createdAt: 1 };
    expect(parseCloudMove(input)).toEqual({ ...input, description: 'A stance' });
    expect(parseCloudMove({ move, createdAt: 1 })).toEqual({ move, kind: 'move', description: null, quality: null, createdAt: 1 });
    for (const bad of [{ ...input, kind: 'taunt' }, { ...input, quality: -0.1 }, { ...input, createdAt: '1' }, { ...input, move: { ...move, slot: 'kick' } }]) {
      expect(parseCloudMove(bad)).toBeNull();
    }
    const id = '7a1c0de0-0000-4000-8000-000000000001';
    expect(parseLoadoutSelection({ light1: id, victory: id })).toEqual({ light1: id, victory: id });
    expect(parseLoadoutSelection({ Light: id })).toBeNull();
    expect(parseLoadoutSelection(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, id])))).toBeNull();
    expect(parseLoadoutSelection([id])).toBeNull();
  });

  it('shape-checks passkey answers', () => {
    const registration = { id: 'abc', type: 'public-key', response: { clientDataJSON: 'e30', attestationObject: 'oA', transports: ['internal'] } };
    expect(parsePasskeyRegistration(registration)).toEqual(registration);
    expect(parsePasskeyRegistration({ ...registration, type: 'password' })).toBeNull();
    expect(parsePasskeyRegistration({ ...registration, response: { ...registration.response, transports: [1] } })).toBeNull();
    const assertion = { id: 'abc', type: 'public-key', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } };
    expect(parsePasskeyAssertion(assertion)).toEqual({ ...assertion, response: { ...assertion.response, userHandle: null } });
    expect(parsePasskeyAssertion({ ...assertion, response: { ...assertion.response, signature: 1 } })).toBeNull();
  });
});

describe('parseServerMessage', () => {
  it('checks only the type', () => {
    expect(parseServerMessage('{"type":"joined","player":1}')).toEqual({ type: 'joined', player: 1 });
    expect(parseServerMessage('{"type":"sync","lateness":1.5}')).toEqual({ type: 'sync', lateness: 1.5 });
    expect(parseServerMessage('{"type":"join"}')).toBeNull();
    expect(parseServerMessage('nope')).toBeNull();
  });
});

describe('parseMoveNameRequest', () => {
  const valid = { slot: 'heavy', limb: 'rightKnee', height: 'high', peakSpeed: 7.5, keyframes: [PNG, PNG, WEBP] };

  it('accepts slot, limb, height, speed and 3 PNG or WebP keyframes', () => {
    expect(parseMoveNameRequest({ ...valid, extra: 'dropped' })).toEqual(valid);
  });

  it('refuses anything else', () => {
    expect(parseMoveNameRequest({ ...valid, keyframes: [PNG, PNG] })).toBeNull();
    expect(parseMoveNameRequest({ ...valid, keyframes: [PNG, PNG, 'data:image/jpeg;base64,/9j/'] })).toBeNull();
    expect(parseMoveNameRequest({ ...valid, keyframes: [PNG, PNG, `data:image/png;base64,${'A'.repeat(KEYFRAME_MAX_CHARS)}`] })).toBeNull();
    expect(parseMoveNameRequest({ ...valid, keyframes: [PNG, PNG, 'https://example.com/a.png'] })).toBeNull();
    expect(parseMoveNameRequest({ ...valid, limb: 'tail' })).toBeNull();
    expect(parseMoveNameRequest({ ...valid, slot: 'grab' })).toBeNull();
    expect(parseMoveNameRequest({ ...valid, peakSpeed: 101 })).toBeNull();
    expect(parseMoveNameRequest('heavy')).toBeNull();
  });
});

describe('parseMatchTipsRequest', () => {
  const stat = { name: '  Thunder   Fist ', slot: 'heavy', uses: 6, hits: 2, blocks: 3, parries: 1, misses: 0 };

  it('cleans move names and keeps only known fields', () => {
    expect(parseMatchTipsRequest({ moves: [{ ...stat, height: 'mid', secret: 1 }], damageDealt: 40, damageTaken: 55, result: 'loss' })).toEqual({
      moves: [{ name: 'Thunder Fist', slot: 'heavy', height: 'mid', uses: 6, hits: 2, blocks: 3, parries: 1, misses: 0 }],
      damageDealt: 40,
      damageTaken: 55,
      result: 'loss',
    });
  });

  it('refuses bad stats', () => {
    const request = (overrides: Record<string, unknown>) => ({ moves: [stat], damageDealt: 1, damageTaken: 1, ...overrides });
    expect(parseMatchTipsRequest(request({}))).not.toBeNull();
    expect(parseMatchTipsRequest(request({ moves: [] }))).toBeNull();
    expect(parseMatchTipsRequest(request({ moves: Array.from({ length: 10 }, () => stat) }))).toBeNull();
    expect(parseMatchTipsRequest(request({ moves: [{ ...stat, uses: -1 }] }))).toBeNull();
    expect(parseMatchTipsRequest(request({ moves: [{ ...stat, hits: 1.5 }] }))).toBeNull();
    expect(parseMatchTipsRequest(request({ moves: [{ ...stat, name: 'Bad\u0000Name' }] }))).toBeNull();
    expect(parseMatchTipsRequest(request({ moves: [{ ...stat, height: 'ankle' }] }))).toBeNull();
    expect(parseMatchTipsRequest(request({ damageDealt: 100_001 }))).toBeNull();
    expect(parseMatchTipsRequest(request({ result: 'victory' }))).toBeNull();
  });
});
