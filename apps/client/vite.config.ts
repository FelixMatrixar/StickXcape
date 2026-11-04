import { defaultClientConditions, defineConfig } from 'vite';

/**
 * The game client. In development Vite serves it on :5173 and forwards the services' routes to
 * the server on :8080 (`npm run dev` at the repo root), so rooms, the relay and AI work as in
 * production. Practice fights and Move Studio work without the server.
 */
const SERVICES = 'http://localhost:8080';

export default defineConfig({
  resolve: {
    // Workspace packages build straight from their TypeScript sources.
    conditions: ['source', ...defaultClientConditions],
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/rooms': SERVICES,
      '/ai': SERVICES,
      '/version': SERVICES,
      '/healthz': SERVICES,
      '/arenas': SERVICES,
      '/reports': SERVICES,
      '/account': SERVICES,
      '/ws': { target: SERVICES, ws: true },
    },
  },
  build: {
    // iPhones from iOS 15 and Android Chrome from 2021, as in the frontend PRD's test devices.
    target: ['safari15', 'chrome96'],
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
