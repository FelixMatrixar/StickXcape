import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parseMatchTipsRequest, parseMoveNameRequest, PLAYER_ID_HEADER, PLAYER_ID_PATTERN } from '@sticxcape/shared';
import { AiRateLimitedError, AiUnavailableError, type AiGateway, type Requester } from './gateway.ts';

/** Three keyframe images fit comfortably under this. */
const MOVE_NAME_BODY_LIMIT = 400 * 1024;

/** POST /ai/move-name and POST /ai/match-tips (Integration PRD: HTTP API). */
export function registerAiRoutes(app: FastifyInstance, { gateway }: { gateway: AiGateway }): void {
  app.post('/ai/move-name', { bodyLimit: MOVE_NAME_BODY_LIMIT }, async (request, reply) => {
    const body = parseMoveNameRequest(request.body);
    if (!body) {
      return reply.code(400).send({ error: 'bad_request', message: 'Expected slot, limb, height, peakSpeed and 3 PNG or WebP keyframes' });
    }
    try {
      return await gateway.moveName(body, requester(request));
    } catch (err) {
      return failure(reply, err);
    }
  });

  app.post('/ai/match-tips', async (request, reply) => {
    const body = parseMatchTipsRequest(request.body);
    if (!body) return reply.code(400).send({ error: 'bad_request', message: 'Expected per-move stats plus damage dealt and taken' });
    try {
      return await gateway.matchTips(body, requester(request));
    } catch (err) {
      return failure(reply, err);
    }
  });
}

function requester(request: FastifyRequest): Requester {
  const id = request.headers[PLAYER_ID_HEADER];
  const playerKey = typeof id === 'string' && PLAYER_ID_PATTERN.test(id) ? `player:${id}` : `ip:${request.ip}`;
  return { playerKey, ip: request.ip };
}

function failure(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof AiRateLimitedError) {
    return reply.code(429).send({ error: 'rate_limited', message: 'Daily Meta AI limit reached; the game uses its default instead' });
  }
  if (err instanceof AiUnavailableError) return reply.code(503).send({ error: 'ai_unavailable', message: 'Meta AI is unavailable right now' });
  throw err;
}
