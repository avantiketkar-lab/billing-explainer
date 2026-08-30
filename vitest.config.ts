import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the tests answer two different questions.
 *
 *   workers/ — behavioural tests needing real bindings (D1, the audit DO).
 *              These run inside workerd, where `node:fs` does not exist.
 *   node/    — pure unit tests, plus the STRUCTURAL tests that scan the source
 *              tree. Those need a real filesystem, which is precisely why they
 *              cannot live in the workers project.
 */
export default defineConfig({
  test: {
    projects: [
      './vitest.workers.config.ts',
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/node/**/*.test.ts'],
        },
      },
    ],
  },
});
