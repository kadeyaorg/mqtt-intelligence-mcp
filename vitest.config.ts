import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
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
