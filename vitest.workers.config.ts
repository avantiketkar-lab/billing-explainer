import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    name: 'workers',
    include: ['test/workers/**/*.test.ts'],
    setupFiles: ['./test/workers/setup.ts'],
    poolOptions: {
      workers: {
        // Workflows cannot run with per-test isolated storage. The suite is
        // written to be order-independent instead of relying on isolation.
        isolatedStorage: false,
        singleWorker: true,
        // A minimal entry that omits the MCP transport — see test/workers/entry.ts
        // for why, and for what covers the transport instead.
        main: './test/workers/entry.ts',
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: { SESSION_SECRET: 'test-secret-not-for-production' },
        },
      },
    },
  },
});
