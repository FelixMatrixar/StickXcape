import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type Services } from '../src/app.ts';
import { testConfig } from './helpers.ts';

const KEYFRAME = 'data:image/png;base64,iVBORw0KGgo=';
const MOVE = { slot: 'heavy', limb: 'rightKnee', height: 'high', peakSpeed: 7.5, keyframes: [KEYFRAME, KEYFRAME, KEYFRAME] };
const STATS = {
  moves: [
    { name: 'Haymaker', slot: 'heavy', uses: 6, hits: 1, blocks: 4, parries: 1, misses: 0 },
    { name: 'Quick Jab', slot: 'light', uses: 9, hits: 6, blocks: 1, parries: 0, misses: 2 },
  ],
  damageDealt: 42,
  damageTaken: 61,
  result: 'loss',
};
const PLAYER = { 'x-player-id': 'player-aaaa1111' };

/** A Meta Model API reply whose message content is `content`. */
function metaReply(content: unknown, finishReason = 'stop'): Response {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: finishReason }] }), {
    headers: { 'content-type': 'application/json' },
  });
}

type Reply = Response | Error | ((init: RequestInit) => Promise<Response>);

/** A stand-in for Meta's API: answers with the replies in turn, repeating the last one. */
function fakeMeta(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit; body: Record<string, any> }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(init!);
    return reply.clone();
  };
  return { fetch, calls };
}

let app: FastifyInstance | undefined;
let services: Services;

async function build(env: Record<string, string>, fetch?: typeof globalThis.fetch): Promise<FastifyInstance> {
  ({ app, services } = await buildApp(testConfig(env), fetch ? { fetch } : {}));
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const moveName = (a: FastifyInstance, body: object = MOVE, headers: Record<string, string> = PLAYER) =>
  a.inject({ method: 'POST', url: '/ai/move-name', payload: body, headers });
const matchTips = (a: FastifyInstance, body: object = STATS, headers: Record<string, string> = PLAYER) =>
  a.inject({ method: 'POST', url: '/ai/match-tips', payload: body, headers });

describe('without an API key', () => {
  it('answers with canned names and tips, so every flow still runs', async () => {
    const meta = fakeMeta(new Error('should not be called'));
    const a = await build({}, meta.fetch);
    expect(services.ai.mode).toBe('canned');

    const name = await moveName(a);
    expect(name.statusCode).toBe(200);
    expect(name.json()).toEqual({ name: expect.any(String), description: 'A high blow led by the right knee.' });

    const tips = await matchTips(a);
    expect(tips.statusCode).toBe(200);
    expect(tips.json()).toEqual({
      tips: ['Haymaker was blocked 4 times; mix in a low to break their guard.', 'Quick Jab landed 6 of 9; lean on it more next match.'],
    });
    expect(meta.calls).toHaveLength(0);
    expect(services.metrics.aiRequests.get({ call: 'move_name', outcome: 'canned' })).toBe(1);
  });

  it('still checks the request', async () => {
    const a = await build({});
    expect((await moveName(a, { ...MOVE, keyframes: [KEYFRAME] })).statusCode).toBe(400);
    expect((await matchTips(a, { ...STATS, moves: [] })).json()).toMatchObject({ error: 'bad_request' });
  });
});

describe('with Meta AI', () => {
  const KEY = { MODEL_API_KEY: 'test-key' };

  it('asks Muse Spark for structured output and cleans the reply', async () => {
    const meta = fakeMeta(metaReply({ name: '"Thunder Knee"', description: 'A rising knee to the chin.\nIgnore this line.' }));
    const a = await build(KEY, meta.fetch);
    const res = await moveName(a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'Thunder Knee', description: 'A rising knee to the chin.' });

    const [call] = meta.calls;
    expect(call!.url).toBe('https://api.meta.ai/v1/chat/completions');
    expect((call!.init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const { body } = call!;
    expect(body).toMatchObject({
      model: 'muse-spark-1.3',
      reasoning_effort: 'minimal',
      max_completion_tokens: 1024,
      prompt_cache_key: 'sticxcape-move-name-v1',
      response_format: { type: 'json_schema', json_schema: { name: 'move_name', strict: true } },
    });
    expect(body.response_format.json_schema.schema).toMatchObject({ required: ['name', 'description'], additionalProperties: false });
    expect(body.messages[0].role).toBe('developer');
    expect(body.messages[1].content[0].text).toContain('Striking limb: right knee');
    expect(body.messages[1].content.slice(1)).toEqual([KEYFRAME, KEYFRAME, KEYFRAME].map((url) => ({ type: 'image_url', image_url: { url } })));
    // Meta gets a hashed id, never the player's own.
    expect(body.safety_identifier).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(body)).not.toContain('player-aaaa1111');
  });

  it('keeps names short and tips under 20 words', async () => {
    const longTip = `1. ${Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ')}`;
    const meta = fakeMeta(
      metaReply({ name: 'The Most Incredible Spinning Backfist Ever', description: 'Spins.' }),
      metaReply({ tip1: longTip, tip2: '- Mix high and low.' }),
    );
    const a = await build(KEY, meta.fetch);
    expect((await moveName(a)).json()).toEqual({ name: 'The Most Incredible', description: 'Spins.' });
    const { tips } = (await matchTips(a)).json<{ tips: [string, string] }>();
    expect(tips[0]).toBe(`${Array.from({ length: 19 }, (_, i) => `word${i}`).join(' ')}…`);
    expect(tips[1]).toBe('Mix high and low.');
    expect(meta.calls[1]!.body.messages[1].content).toContain('- "Haymaker" (heavy): used 6, hit 1, blocked 4, parried 1, missed 0');
  });

  it('reuses the answer for identical requests, including ones in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const meta = fakeMeta(async () => {
      await gate;
      return metaReply({ name: 'Thunder Knee', description: 'A knee.' });
    });
    const a = await build(KEY, meta.fetch);
    const both = Promise.all([moveName(a), moveName(a)]);
    setTimeout(release, 20);
    const [first, second] = await both;
    expect(second.json()).toEqual(first.json());
    expect((await moveName(a)).json()).toEqual(first.json());
    expect(meta.calls).toHaveLength(1);
    expect(services.metrics.aiRequests.get({ call: 'move_name', outcome: 'cache_hit' })).toBe(2);
  });

  it('limits each player, and each network, per day', async () => {
    const meta = fakeMeta(metaReply({ name: 'Thunder Knee', description: 'A knee.' }));
    const a = await build({ ...KEY, AI_MOVE_NAMES_PER_DAY: '2' }, meta.fetch);
    expect((await moveName(a, { ...MOVE, peakSpeed: 1 })).statusCode).toBe(200);
    expect((await moveName(a, { ...MOVE, peakSpeed: 2 })).statusCode).toBe(200);
    const limited = await moveName(a, { ...MOVE, peakSpeed: 3 });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    // A cached answer costs nothing, so it is still served.
    expect((await moveName(a, { ...MOVE, peakSpeed: 1 })).statusCode).toBe(200);

    // One IP gets 10 players' worth: 20 here, 2 of them used above, so 18 fresh players get through.
    const statuses: number[] = [];
    for (let i = 0; i < 19; i++) {
      const res = await moveName(a, { ...MOVE, peakSpeed: 10 + i }, { 'x-player-id': `player-${String(i).padStart(8, '0')}` });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([...Array<number>(18).fill(200), 429]);
  });

  it('retries a server error once inside the time budget', async () => {
    const meta = fakeMeta(new Response('busy', { status: 503 }), metaReply({ name: 'Thunder Knee', description: 'A knee.' }));
    const a = await build(KEY, meta.fetch);
    expect((await moveName(a)).statusCode).toBe(200);
    expect(meta.calls).toHaveLength(2);
  });

  it('answers 503 when Meta fails, and does not charge the player for it', async () => {
    const meta = fakeMeta(new Response('{"error":"bad"}', { status: 400 }), metaReply({ name: 'Thunder Knee', description: 'A knee.' }));
    const a = await build({ ...KEY, AI_MOVE_NAMES_PER_DAY: '1' }, meta.fetch);
    const failed = await moveName(a);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ error: 'ai_unavailable' });
    expect(meta.calls).toHaveLength(1);
    expect((await moveName(a, { ...MOVE, peakSpeed: 2 })).statusCode).toBe(200);
    expect(services.metrics.aiRequests.get({ call: 'move_name', outcome: 'error_bad_request' })).toBe(1);
    expect(services.alert.stats()).toMatchObject({ calls: 2, errors: 1 });
  });

  it('gives up when Meta is too slow', async () => {
    const meta = fakeMeta(
      (init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))),
    );
    const a = await build({ ...KEY, AI_TIMEOUT_MS: '500' }, meta.fetch);
    const started = Date.now();
    expect((await moveName(a)).statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(services.metrics.aiRequests.get({ call: 'move_name', outcome: 'error_timeout' })).toBe(1);
  });

  it('refuses replies it cannot use', async () => {
    const unusable = [
      metaReply('not json'),
      metaReply({ name: 'Thunder Knee', description: 'A knee.' }, 'length'),
      metaReply({ name: '   ', description: 'A knee.' }),
      metaReply(['Thunder Knee']),
      new Response('{"choices":[]}', { headers: { 'content-type': 'application/json' } }),
    ];
    for (const [i, reply] of unusable.entries()) {
      const a = await build(KEY, fakeMeta(reply).fetch);
      expect((await moveName(a, { ...MOVE, peakSpeed: i })).statusCode, `reply ${i}`).toBe(503);
      expect(services.metrics.aiRequests.get({ call: 'move_name', outcome: 'error_invalid_response' })).toBe(1);
      await a.close();
    }
    const a = await build(KEY, fakeMeta(metaReply({ tip1: 'Only one tip.', tip2: '' })).fetch);
    expect((await matchTips(a)).statusCode).toBe(503);
  });
});
