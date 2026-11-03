import type { FastifyInstance } from 'fastify';
import type { Relay } from './relay.ts';

export interface RelayRoutesOptions {
  relay: Relay;
  /** Browser origins allowed to connect; empty allows any. */
  allowedOrigins: string[];
}

/** The relay's WebSocket endpoint: wss://host/ws. */
export function registerRelayRoutes(app: FastifyInstance, { relay, allowedOrigins }: RelayRoutesOptions): void {
  app.get(
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
