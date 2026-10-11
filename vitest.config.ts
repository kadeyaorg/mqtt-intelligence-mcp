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
    coverage: {
      provider: 'v8',
      // Projects have their own roots, so the pattern must not assume the workspace one.
      include: ['**/src/**/*.ts'],
      exclude: ['**/dist/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
