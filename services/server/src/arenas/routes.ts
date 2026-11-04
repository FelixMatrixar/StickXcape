import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ARENA_IMAGE_MAX_BYTES,
  ARENA_IMAGE_MAX_SIDE,
  ARENA_IMAGE_MIN_SIDE,
  ARENA_LINK_PATH,
  isArenaId,
  parseArenaFile,
  parseArenaPalette,
  parseRoomReport,
  photoArenaLayer,
  PLAYER_ID_HEADER,
  PLAYER_ID_PATTERN,
  type ApiError,
  type ShareArenaResponse,
  type SharedArenaResponse,
} from '@sticxcape/shared';
import { playerKeyHash, type AccountStore } from '../accounts/store.ts';
import type { AiGateway, Requester } from '../ai/gateway.ts';
import type { Config } from '../config.ts';
import { jpegSize } from '../lib/jpeg.ts';
import { WindowLimiter } from '../lib/limits.ts';
import { multipartBoundary, parseMultipart } from '../lib/multipart.ts';
import type { Metrics } from '../metrics/metrics.ts';

export interface ArenaRoutesOptions {
  config: Config;
  /** Shared arenas and reports live with the accounts; without a database they are off. */
  store: AccountStore | null;
  ai: AiGateway;
  metrics: Metrics;
  now: () => number;
}

/** The backdrop plus the arena file and palette, with room to spare for the form's own bytes. */
const SHARE_BODY_LIMIT = ARENA_IMAGE_MAX_BYTES + 64 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Shares one network may start an hour, and arenas one phone may keep shared. */
const SHARES_PER_IP_PER_HOUR = 10;
const SHARED_ARENAS_PER_PLAYER = 30;
/** Reports one phone may send a day, and one network an hour. */
const REPORTS_PER_PLAYER_PER_DAY = 20;
const REPORTS_PER_IP_PER_HOUR = 60;

/**
 * Shared photo arenas (AR-4, AR-5, AR-7) and reports from friend rooms, in the shape the game
 * client already uses:
 *
 * - POST /arenas, a multipart form with `file` (the arena JSON), `image` (the JPEG backdrop) and
 *   `palette`, sent with X-Player-Id → 201 { id, link }. The arena keeps its own id, so the link
 *   is /a/{id} on every phone. Before anything is stored the server checks the file, the image
 *   and the palette, and Muse Spark checks the name and looks over the backdrop once more.
 * - GET /arenas/{id} → { file, imageUrl, palette }, and GET /arenas/{id}/image → the JPEG.
 * - DELETE /arenas/{id}, from the phone that shared it.
 * - POST /reports { nickname, reason, room, at } with X-Player-Id → 202.
 *
 * Links are unguessable ids, so anyone with one can open the arena: friends-only sharing.
 */
export function registerArenaRoutes(app: FastifyInstance, { config, store, ai, metrics, now }: ArenaRoutesOptions): { prune(at: number): void } {
  const shareLimiter = new WindowLimiter(SHARES_PER_IP_PER_HOUR, HOUR_MS);
  const reportLimiter = new WindowLimiter(REPORTS_PER_IP_PER_HOUR, HOUR_MS);
  // Kept as raw bytes: only POST /arenas reads a multipart body, and it parses it itself.
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: SHARE_BODY_LIMIT }, (_request, body, done) => done(null, body));

  const origin = (request: FastifyRequest) => config.publicUrl ?? `${request.protocol}://${request.host}`;

  const sharingOff = (reply: FastifyReply) => reply.code(503).send(apiError('sharing_off', 'Sharing photo arenas is switched off on this server'));

  app.post<{ Reply: ShareArenaResponse | ApiError }>('/arenas', { bodyLimit: SHARE_BODY_LIMIT }, async (request, reply) => {
    if (!store) return sharingOff(reply);
    // The header also keeps other sites out: a plain form can't send it.
    const playerId = request.headers[PLAYER_ID_HEADER];
    if (typeof playerId !== 'string' || !PLAYER_ID_PATTERN.test(playerId)) return reply.code(400).send(apiError('no_player_id', 'Send the X-Player-Id header'));

    const boundary = multipartBoundary(request.headers['content-type']);
    const parts = boundary && Buffer.isBuffer(request.body) ? parseMultipart(request.body, boundary) : null;
    if (!parts) return reply.code(400).send(apiError('bad_arena', 'Send a multipart form with file, image and palette'));
    const field = (name: string) => parts.find((part) => part.name === name);
    const file = parseArenaFile(parseJson(field('file')?.data));
    const palette = parseArenaPalette(parseJson(field('palette')?.data));
    const image = field('image')?.data;
    // A photo arena draws only its own backdrop, never art from anywhere else.
    if (!file || file.layers.length !== 1 || file.layers[0] !== photoArenaLayer(file.id)) {
      return reply.code(400).send(apiError('bad_arena', 'The arena file is malformed or not a photo arena'));
    }
    if (!palette) return reply.code(400).send(apiError('bad_arena', 'The palette is malformed'));
    const size = image && image.length <= ARENA_IMAGE_MAX_BYTES ? jpegSize(image) : null;
    if (!image || !size) return reply.code(400).send(apiError('bad_image', 'The backdrop must be a JPEG of at most 1.5 MB'));
    const sides = [size.width, size.height];
    if (Math.max(...sides) > ARENA_IMAGE_MAX_SIDE || Math.min(...sides) < ARENA_IMAGE_MIN_SIDE) {
      return reply.code(400).send(apiError('bad_image', `The backdrop must be ${ARENA_IMAGE_MIN_SIDE} to ${ARENA_IMAGE_MAX_SIDE} pixels a side`));
    }

    const ownerKey = playerKeyHash(playerId);
    const link = `${origin(request)}${ARENA_LINK_PATH}${file.id}`;
    // Sharing again (a retry) answers at once; an id someone else shared is theirs.
    const owner = store.sharedArenaOwner(file.id);
    if (owner === ownerKey) return reply.code(200).send({ id: file.id, link });
    if (owner !== undefined) return reply.code(409).send(apiError('arena_taken', 'An arena with this id is already shared'));
    if (!shareLimiter.take(request.ip, now())) return reply.code(429).send(apiError('too_many_shares', 'Too many arenas shared from this network; try again later'));
    if (store.sharedArenaCount(ownerKey) >= SHARED_ARENAS_PER_PLAYER) {
      return reply.code(409).send(apiError('too_many_arenas', `A phone can share at most ${SHARED_ARENAS_PER_PLAYER} arenas; delete one first`));
    }

    const who: Requester = { playerKey: `player:${playerId}`, ip: request.ip };
    if ((await ai.checkName(file.name, who)) === 'blocked') {
      metrics.arenaShares.inc({ outcome: 'name_blocked' });
      return reply.code(400).send(apiError('name_blocked', "That arena name can't be shared; pick another"));
    }
    const check = await ai.checkArenaImage(image, who);
    if (check.verdict === 'flagged') {
      metrics.arenaShares.inc({ outcome: 'image_blocked' });
      request.log.info({ arena: file.id, reason: check.reason }, 'arena backdrop refused');
      return reply.code(400).send(apiError('image_blocked', `This backdrop can't be shared: ${check.reason ?? 'it may show something private'}`));
    }
    // AR-5: in production nothing is shared unchecked. Without a Meta key (development) it is.
    if (check.verdict === 'unchecked' && config.env === 'production') {
      metrics.arenaShares.inc({ outcome: 'unchecked' });
      return reply.code(503).send(apiError('check_unavailable', "The backdrop couldn't be checked right now; try again later"));
    }

    if (store.shareArena(file, palette, image, ownerKey, null) === 'taken') {
      return reply.code(409).send(apiError('arena_taken', 'An arena with this id is already shared'));
    }
    metrics.arenaShares.inc({ outcome: 'shared' });
    request.log.info({ arena: file.id, bytes: image.length, width: size.width, height: size.height }, 'arena shared');
    return reply.code(201).send({ id: file.id, link });
  });

  app.get<{ Params: { id: string }; Reply: SharedArenaResponse | ApiError }>('/arenas/:id', async (request, reply) => {
    if (!store) return sharingOff(reply);
    const arena = isArenaId(request.params.id) ? store.sharedArena(request.params.id) : undefined;
    if (!arena) return reply.code(404).send(apiError('not_found', 'That arena is not shared, or was deleted'));
    reply.header('cache-control', 'no-store');
    return { file: arena.file, imageUrl: `${origin(request)}/arenas/${arena.file.id}/image`, palette: arena.palette };
  });

  app.get<{ Params: { id: string } }>('/arenas/:id/image', async (request, reply) => {
    if (!store) return sharingOff(reply);
    const found = isArenaId(request.params.id) ? store.sharedArenaImage(request.params.id) : undefined;
    if (!found) return reply.code(404).send(apiError('not_found', 'That arena is not shared, or was deleted'));
    const etag = `"${found.hash}"`;
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    // An id's backdrop never changes, but a deleted one should stop showing within the hour.
    return reply.type('image/jpeg').header('etag', etag).header('cache-control', 'public, max-age=3600').send(Buffer.from(found.image));
  });

  app.delete<{ Params: { id: string } }>('/arenas/:id', async (request, reply) => {
    if (!store) return sharingOff(reply);
    const playerId = request.headers[PLAYER_ID_HEADER];
    const owner = typeof playerId === 'string' && PLAYER_ID_PATTERN.test(playerId) ? playerKeyHash(playerId) : null;
    // Someone else's arena and a missing one look the same.
    if (!owner || !isArenaId(request.params.id) || !store.deleteSharedArena(request.params.id, owner)) {
      return reply.code(404).send(apiError('not_found', 'No arena of yours with that id is shared'));
    }
    return reply.code(204).send();
  });

  /** Reports from friend rooms, by nickname: stored for review, nothing happens automatically. */
  app.post<{ Reply: { received: true } | ApiError }>('/reports', async (request, reply) => {
    if (!store) return reply.code(503).send(apiError('reports_off', 'Reports are switched off on this server; the phone will send it again later'));
    const playerId = request.headers[PLAYER_ID_HEADER];
    const reporterKey = typeof playerId === 'string' && PLAYER_ID_PATTERN.test(playerId) ? playerKeyHash(playerId) : `ip:${request.ip}`;
    const report = parseRoomReport(request.body);
    if (!report) return reply.code(400).send(apiError('bad_report', 'Expected nickname, reason (name, moves, cheating or other), room and at'));
    if (!reportLimiter.take(request.ip, now()) || store.roomReportsSince(reporterKey, now() - DAY_MS) >= REPORTS_PER_PLAYER_PER_DAY) {
      return reply.code(429).send(apiError('too_many_reports', 'Too many reports; try again tomorrow'));
    }
    store.addRoomReport(reporterKey, report);
    metrics.roomReports.inc();
    request.log.info({ room: report.room, nickname: report.nickname, reason: report.reason }, 'player reported from a room');
    return reply.code(202).send({ received: true });
  });

  return {
    prune(at: number) {
      shareLimiter.prune(at);
      reportLimiter.prune(at);
    },
  };
}

function parseJson(data: Buffer | undefined): unknown {
  if (!data || data.length > 64 * 1024) return null;
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  }
}

function apiError(error: string, message: string): ApiError {
  return { error, message };
}
