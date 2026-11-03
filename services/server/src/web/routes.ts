import send from '@fastify/send';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ROOM_LINK_PATH } from '@sticxcape/shared';

export interface WebOptions {
  /** Folder holding the built web app (index.html plus assets). */
  webRoot: string;
  /** Folder holding the built relay lab, or null to leave /lab off. */
  labRoot: string | null;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Headers for every response. HSTS only goes out over HTTPS, as browsers ignore it otherwise. */
export function addSecurityHeaders(app: FastifyInstance, hsts: boolean): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (hsts && request.protocol === 'https') reply.header('strict-transport-security', 'max-age=31536000');
  });
}

/**
 * Web hosting: serves the web app's files, answers invite links (/r/{code}) and other app routes
 * with its index.html, and serves the relay lab at /lab/.
 */
export function registerWeb(app: FastifyInstance, { webRoot, labRoot }: WebOptions): void {
  if (labRoot) {
    app.get('/lab', async (request, reply) => reply.redirect(`/lab/${querySuffix(request.url)}`));
    app.get('/lab/*', async (request, reply) => {
      const path = pathname(request.url).slice('/lab'.length);
      return (await sendFile(request, reply, labRoot, path === '/' ? '/index.html' : path, { maxAge: 0 })) ? reply : notFound(reply);
    });
  }

  app.get('/*', async (request, reply) => {
    const path = pathname(request.url);
    if (path.startsWith(ROOM_LINK_PATH) || !/\.[A-Za-z0-9]+$/.test(path)) {
      return (await sendFile(request, reply, webRoot, '/index.html', { maxAge: 0 })) ? reply : notFound(reply);
    }
    // Vite puts content-hashed files under /assets/, so they can be cached for good.
    const cache = path.startsWith('/assets/') ? { maxAge: YEAR_MS, immutable: true } : { maxAge: HOUR_MS };
    return (await sendFile(request, reply, webRoot, path, cache)) ? reply : notFound(reply);
  });
}

/** Streams a file into the reply; false when there is no such file. */
async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  root: string,
  path: string,
  cache: { maxAge: number; immutable?: boolean },
): Promise<boolean> {
  const result = await send(request.raw, path, { root, dotfiles: 'ignore', index: false, maxAge: cache.maxAge, immutable: cache.immutable ?? false });
  if (result.type === 'directory' || (result.type === 'error' && result.statusCode === 404)) return false;
  // Not returned: a Fastify reply is awaitable, and returning it from an async helper would wait for the response.
  void reply.code(result.statusCode).headers(result.headers).send(result.stream);
  return true;
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'not_found', message: 'Not found' });
}

function pathname(url: string): string {
  const query = url.indexOf('?');
  return query >= 0 ? url.slice(0, query) : url;
}

function querySuffix(url: string): string {
  const query = url.indexOf('?');
  return query >= 0 ? url.slice(query) : '';
}
