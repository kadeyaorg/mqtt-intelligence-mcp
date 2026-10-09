// @ts-check
import path from 'node:path';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import moduleBoundaries from './module-boundaries.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const root = path.resolve('/repo/packages/core/src');

/** @param {string} relativePath */
const file = (relativePath) => path.join(root, ...relativePath.split('/'));

const options = [
  {
    root,
    modules: {
      domain: [],
      policy: ['domain'],
      transport: ['domain'],
      broker: ['domain', 'policy', 'transport'],
    },
    privateSubmodules: ['transport/mqttjs'],
  },
];

const ruleTester = new RuleTester({
  languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
});

ruleTester.run('module-boundaries', moduleBoundaries, {
  valid: [
    {
      name: 'import within the same module',
      filename: file('domain/a.ts'),
      code: "import { b } from './b.js';",
      options,
    },
    {
      name: 'import of an allowed module',
      filename: file('policy/rules.ts'),
      code: "import { t } from '../domain/topic.js';",
      options,
    },
    {
      name: 'type-only import of an allowed module',
      filename: file('broker/c.ts'),
      code: "import type { P } from '../transport/port.js';",
      options,
    },
    {
      name: 're-export from an allowed module',
      filename: file('broker/index.ts'),
      code: "export * from '../policy/rules.js';",
      options,
    },
    {
      name: 'root file imports anything',
      filename: file('engine.ts'),
      code: "import { M } from './transport/mqttjs/adapter.js';",
      options,
    },
    {
      name: 'private submodule imports itself',
      filename: file('transport/mqttjs/adapter.ts'),
      code: "import { o } from './options.js';",
      options,
    },
    {
      name: 'package imports are ignored',
      filename: file('domain/a.ts'),
      code: "import path from 'node:path';",
      options,
    },
    {
      name: 'files outside the root are ignored',
      filename: path.resolve('/repo/packages/core/test/a.test.ts'),
      code: "import { x } from '../src/broker/c.js';",
      options,
    },
  ],
  invalid: [
    {
      name: 'forbidden module dependency',
      filename: file('domain/a.ts'),
      code: "import { p } from '../policy/rules.js';",
      options,
      errors: [{ messageId: 'forbidden' }],
    },
    {
      name: 'forbidden dynamic import',
      filename: file('domain/a.ts'),
      code: "await import('../broker/c.js');",
      options,
      errors: [{ messageId: 'forbidden' }],
    },
    {
      name: 'forbidden re-export',
      filename: file('policy/index.ts'),
      code: "export { c } from '../broker/c.js';",
      options,
      errors: [{ messageId: 'forbidden' }],
    },
    {
      name: 'module importing the public index',
      filename: file('policy/rules.ts'),
      code: "import { x } from '../index.js';",
      options,
      errors: [{ messageId: 'rootFile' }],
    },
    {
      name: 'private submodule imported by another module',
      filename: file('broker/c.ts'),
      code: "import { M } from '../transport/mqttjs/adapter.js';",
      options,
      errors: [{ messageId: 'privateSubmodule' }],
    },
    {
      name: 'private submodule imported by its parent module',
      filename: file('transport/port.ts'),
      code: "import { M } from './mqttjs/adapter.js';",
      options,
      errors: [{ messageId: 'privateSubmodule' }],
    },
    {
      name: 'undeclared importer module',
      filename: file('ingest/a.ts'),
      code: "import { t } from '../domain/topic.js';",
      options,
      errors: [{ messageId: 'unknownModule' }],
    },
    {
      name: 'undeclared target module',
      filename: file('broker/c.ts'),
      code: "import { s } from '../store/s.js';",
      options,
      errors: [{ messageId: 'forbidden' }],
    },
    {
      name: 'import leaving the source root',
      filename: file('domain/a.ts'),
      code: "import pkg from '../../package.json';",
      options,
      errors: [{ messageId: 'outsideRoot' }],
    },
  ],
});
