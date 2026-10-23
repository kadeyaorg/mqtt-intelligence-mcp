import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
          // Integration tests need Docker; they run as their own project.
          exclude: ['test/integration/**'],
        },
      },
      {
        test: {
          name: 'core-integration',
          root: './packages/core',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          // Containers are slow to start and brokers bind ports: no parallel files.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'mcp-server',
          root: './packages/mcp-server',
          include: ['test/**/*.test.ts'],
          // The example stack needs Docker; it runs as its own project.
          exclude: ['test/integration/**'],
        },
      },
      {
        test: {
          name: 'mcp-server-integration',
          root: './packages/mcp-server',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 300_000,
          // One Compose stack, one published port: nothing here may run in parallel.
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'tools',
          include: ['tools/**/*.test.js'],
        },
      },
    ],
    // Unit projects run on fake clocks and in-memory transports: nothing here measures
    // elapsed time, so a per-test timeout only ever measures the runner. The default 5s is
    // not enough on a loaded Windows runner, where the first test to touch a chunk of the
    // module graph pays for all of it — `lists brokers with their state and coverage` took
    // 5515ms on windows-latest / Node 22 on 2026-10-23 and 18ms locally on the same commit.
    // 15s is still far below anything a genuine hang would survive.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      // Projects have their own roots, so the pattern must not assume the workspace one.
      include: ['**/src/**/*.ts'],
      exclude: ['**/dist/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
