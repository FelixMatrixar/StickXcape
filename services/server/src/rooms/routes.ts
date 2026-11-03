import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cleanText, isRoomCode, NICKNAME_MAX_LENGTH, roomLink, type ApiError, type CreateRoomResponse, type RoomSummary } from '@sticxcape/shared';
import type { Config } from '../config.ts';
import { WindowLimiter } from '../lib/limits.ts';
import type { Metrics } from '../metrics/metrics.ts';
import type { RoomStore } from './room-store.ts';

export interface RoomRoutesOptions {
  config: Config;
  rooms: RoomStore;
  metrics: Metrics;
  now: () => number;
}

/** POST /rooms and GET /rooms/{code} (Integration PRD: HTTP API). */
export function registerRoomRoutes(app: FastifyInstance, { config, rooms, metrics, now }: RoomRoutesOptions): WindowLimiter {
  const createLimiter = new WindowLimiter(config.rooms.createLimitPerIp, config.rooms.createWindowMs);

  app.post<{ Reply: CreateRoomResponse | ApiError }>('/rooms', async (request, reply) => {
    const body = request.body as { nickname?: unknown } | undefined;
    const nickname = cleanText(body?.nickname, NICKNAME_MAX_LENGTH);
    if (nickname === null) {
      return reply.code(400).send({ error: 'bad_nickname', message: `Nickname must be 1 to ${NICKNAME_MAX_LENGTH} characters` });
    }
    if (!createLimiter.take(request.ip, now())) {
      return reply.code(429).send({ error: 'too_many_rooms', message: 'Too many rooms created from this network; try again in a few minutes' });
    }
    const room = rooms.create(nickname);
    if (!room) return reply.code(429).send({ error: 'too_many_rooms', message: 'The server is full; try again soon' });

    metrics.roomsCreated.inc();
    request.log.info({ room: room.code, nickname }, 'room created');
    return reply.code(201).send({ code: room.code, link: roomLink(config.publicUrl ?? requestOrigin(request), room.code) });
  });

  app.get<{ Params: { code: string }; Reply: RoomSummary | ApiError }>('/rooms/:code', async (request, reply) => {
    const code = request.params.code.toLowerCase();
    const room = isRoomCode(code) ? rooms.get(code) : undefined;
    if (!room) return reply.code(404).send({ error: 'not_found', message: 'Room not found or expired' });
    return room.summary();
  });

  return createLimiter;
}

function requestOrigin(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`;
}
