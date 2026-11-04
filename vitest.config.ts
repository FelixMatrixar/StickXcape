import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against the TypeScript sources of the workspace packages, so no build is needed first.
const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sticxcape/shared': src('./packages/shared/src/index.ts'),
      '@sticxcape/netcode': src('./packages/netcode/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
