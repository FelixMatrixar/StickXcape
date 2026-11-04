import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { PROMETHEUS_CONTENT_TYPE } from './metrics/routes.ts';

const config = loadConfig();
const { app, services } = await buildApp(config);
await app.listen({ host: config.host, port: config.port });

// An optional private port for a Prometheus scraper; on Fly.io it is never exposed publicly.
let metricsApp: FastifyInstance | null = null;
if (config.monitoring.metricsPort !== null) {
  metricsApp = Fastify({ logger: false });
  metricsApp.get('/metrics', async (_request, reply) => reply.type(PROMETHEUS_CONTENT_TYPE).send(services.metrics.registry.render()));
  await metricsApp.listen({ host: '::', port: config.monitoring.metricsPort });
}

app.log.info(
  {
    port: config.port,
    publicUrl: config.publicUrl,
    ai: services.ai.mode,
    accounts: services.accounts !== null,
    lab: config.labRoot !== null,
    version: config.serverVersion,
  },
  'SticXcape services ready',
);
if (services.ai.mode === 'canned') app.log.warn('MODEL_API_KEY is not set, so move names and tips are canned answers');
if (!services.accounts) app.log.warn('DATABASE_FILE is not set, so accounts and the cloud move library are off');

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  await app.close();
  await metricsApp?.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
