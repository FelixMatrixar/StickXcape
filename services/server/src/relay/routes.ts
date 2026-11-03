import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from 'fastify';
import type { WebSocket } from 'ws';
import type { Relay } from './relay.ts';

export interface RelayRoutesOptions {
  relay: Relay;
  /** Browser origins allowed to connect; empty allows any. */
  allowedOrigins: string[];
}

type WebSocketRoute = (
  path: string,
  options: RouteShorthandOptions & { websocket: true },
  handler: (socket: WebSocket, request: FastifyRequest) => void,
) => unknown;

/** The relay's WebSocket endpoint: wss://host/ws. */
export function registerRelayRoutes(app: FastifyInstance, { relay, allowedOrigins }: RelayRoutesOptions): void {
  // @fastify/websocket's route typings don't merge under TypeScript 7, so the route is declared through this narrow type.
  const websocketRoute = app.get.bind(app) as unknown as WebSocketRoute;
  websocketRoute(
    '/ws',
    {
      websocket: true,
      // Browsers always send Origin, so a page on another site can't open the relay as a visitor.
      preValidation: async (request, reply) => {
        const origin = request.headers.origin;
        if (origin && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
          return reply.code(403).send({ error: 'forbidden_origin', message: 'This site may not connect to the relay' });
        }
      },
    },
    (socket, request) => relay.accept(socket, request.ip),
  );
}
