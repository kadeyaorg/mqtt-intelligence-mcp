// @ts-check
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import moduleBoundaries from './tools/eslint/module-boundaries.js';

/** npm name of the engine package (provisional scope, see ADR-0002). */
const CORE_PACKAGE = '@kadeya/mqtt-intelligence-core';
/** npm name of the MCP package (provisional scope, see ADR-0002). */
const MCP_PACKAGE = '@kadeya/mqtt-intelligence-mcp';

/**
 * Dependency table of the core's top-level modules (docs/proposal/03-architecture.md).
 * A module missing from this table cannot import anything: adding one is a reviewed change.
 */
const CORE_MODULES = {
  domain: [],
  config: ['domain'],
  payload: ['domain'],
  policy: ['domain'],
  observability: ['domain'],
  transport: ['domain', 'observability'],
  catalog: ['domain', 'payload'],
  store: ['domain', 'payload', 'catalog'],
  broker: ['domain', 'policy', 'transport', 'observability'],
  subscription: ['domain', 'policy', 'transport', 'broker', 'observability'],
  ingest: [
    'domain',
    'config',
    'payload',
    'policy',
    'observability',
    'transport',
    'catalog',
    'store',
    'broker',
    'subscription',
  ],
  discovery: [
    'domain',
    'config',
    'payload',
    'policy',
    'observability',
    'transport',
    'catalog',
    'store',
    'broker',
    'subscription',
    'ingest',
  ],
  query: ['domain', 'payload', 'catalog', 'store', 'policy'],
  testing: [
    'domain',
    'config',
    'payload',
    'policy',
    'observability',
    'transport',
    'catalog',
    'store',
    'broker',
    'subscription',
    'ingest',
    'discovery',
    'query',
  ],
};

const NO_MCP_IN_CORE = {
  group: ['@modelcontextprotocol/*', MCP_PACKAGE, `${MCP_PACKAGE}/*`],
  message: 'The core must not depend on MCP (ADR-0003).',
};

const NO_MQTTJS = {
  name: 'mqtt',
  message: 'mqtt.js may only be imported in packages/core/src/transport/mqttjs (ADR-0006).',
};

export default defineConfig(
  globalIgnores(['**/dist/', '**/coverage/']),

  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    plugins: {
      local: { rules: { 'module-boundaries': moduleBoundaries } },
    },
    rules: {
      // Undefined identifiers are reported by the TypeScript compiler (checkJs for .js files).
      'no-undef': 'off',
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },

  {
    name: 'product code: stdout is reserved for MCP stdio frames',
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'stdout',
          message: 'stdout carries MCP protocol frames only; log to stderr through the Logger.',
        },
      ],
    },
  },

  {
    name: 'core: independent from MCP, mqtt.js confined to its adapter',
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [NO_MQTTJS], patterns: [NO_MCP_IN_CORE] }],
      'local/module-boundaries': [
        'error',
        {
          root: 'packages/core/src',
          modules: CORE_MODULES,
          privateSubmodules: ['transport/mqttjs'],
        },
      ],
    },
  },
  {
    name: 'core: the mqtt.js adapter',
    files: ['packages/core/src/transport/mqttjs/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_MCP_IN_CORE] }],
    },
  },

  {
    // A terminal tool a person runs by hand, not product code. The repository bans console
    // because stdout carries MCP protocol frames in the server; here stdout IS the output,
    // and there is no protocol to corrupt.
    name: 'skills: bundled capture scripts print to the terminal',
    files: ['skills/**/scripts/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  {
    name: 'mcp-server: public core API only, no mqtt.js',
    files: ['packages/mcp-server/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [NO_MQTTJS],
          patterns: [
            {
              group: [`${CORE_PACKAGE}/*`],
              message: `Import the public API from "${CORE_PACKAGE}" only.`,
            },
          ],
        },
      ],
    },
  },
  {
    name: 'mcp-server tests: public core API and its testing helpers',
    files: ['packages/mcp-server/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [`${CORE_PACKAGE}/*`, `!${CORE_PACKAGE}/testing`],
              message: `Import from "${CORE_PACKAGE}" or "${CORE_PACKAGE}/testing" only.`,
            },
          ],
        },
      ],
    },
  },
);
