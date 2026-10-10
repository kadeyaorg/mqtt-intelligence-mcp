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
      include: ['packages/*/src/**/*.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
