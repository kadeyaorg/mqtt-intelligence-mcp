// @ts-check
/**
 * ESLint rule enforcing the dependency table between the top-level modules of a source root
 * (ADR-0002, docs/proposal/03-architecture.md "Why not ten packages").
 *
 * - Files directly under the root (composition root, public index) may import anything.
 * - Files inside a module may import their own module and the modules listed for it.
 * - Modules may not import root files (prevents cycles through the public API).
 * - Private submodules (e.g. "transport/mqttjs") may only be imported by their own files and
 *   by root files.
 * - Every top-level directory must appear in the table: adding a module is a deliberate,
 *   reviewed change.
 */
import path from 'node:path';

/**
 * @typedef {object} ModuleBoundariesOptions
 * @property {string} root Source root; relative paths are resolved from the ESLint cwd.
 * @property {Record<string, string[]>} modules Allowed dependencies of each top-level module.
 * @property {string[]} [privateSubmodules] Module-relative paths importable only by their own
 *   files and by root files.
 */

/**
 * @param {string} from
 * @param {string} to
 * @returns {string} `to` relative to `from`, with POSIX separators
 */
function relativePosix(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

/**
 * @param {string} relativePath POSIX path relative to the source root
 * @returns {string | undefined} the top-level module, or undefined for a root file
 */
function moduleOf(relativePath) {
  const separator = relativePath.indexOf('/');
  return separator === -1 ? undefined : relativePath.slice(0, separator);
}

/**
 * @param {string} relativePath
 * @param {string} prefix
 */
function isWithin(relativePath, prefix) {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

/** @type {import('eslint').Rule.RuleModule} */
const moduleBoundaries = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce the dependency table between top-level source modules.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          root: { type: 'string' },
          modules: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
          privateSubmodules: { type: 'array', items: { type: 'string' } },
        },
        required: ['root', 'modules'],
        additionalProperties: false,
      },
    ],
    messages: {
      outsideRoot: 'Import "{{source}}" leaves the source root "{{root}}".',
      rootFile:
        'Module "{{importer}}" must not import the root file "{{target}}"; depend on a module instead.',
      unknownModule:
        'Module "{{module}}" is not declared in the module-boundaries table (eslint.config.js).',
      forbidden: 'Module "{{importer}}" must not depend on module "{{target}}".',
      privateSubmodule:
        '"{{submodule}}" is private: only its own files and the composition root may import it.',
    },
  },

  create(context) {
    /** @type {unknown} */
    const rawOptions = context.options[0];
    // ESLint has already validated the options against `meta.schema`.
    const options = /** @type {ModuleBoundariesOptions} */ (rawOptions);
    const rootAbsolute = path.resolve(context.cwd, options.root);
    const importerRelative = relativePosix(rootAbsolute, context.filename);
    if (importerRelative.startsWith('..') || path.isAbsolute(importerRelative)) {
      return {};
    }
    const importerModule = moduleOf(importerRelative);
    const privateSubmodules = options.privateSubmodules ?? [];

    /** @param {import('estree').Node & { source?: unknown }} node */
    function check(node) {
      const source = node.source;
      if (
        typeof source !== 'object' ||
        source === null ||
        !('value' in source) ||
        typeof source.value !== 'string' ||
        !source.value.startsWith('.')
      ) {
        return;
      }
      const specifier = source.value;
      const targetRelative = relativePosix(
        rootAbsolute,
        path.resolve(path.dirname(context.filename), specifier),
      );

      if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
        context.report({
          node,
          messageId: 'outsideRoot',
          data: { source: specifier, root: options.root },
        });
        return;
      }

      for (const submodule of privateSubmodules) {
        if (
          isWithin(targetRelative, submodule) &&
          importerModule !== undefined &&
          !isWithin(importerRelative, submodule)
        ) {
          context.report({ node, messageId: 'privateSubmodule', data: { submodule } });
          return;
        }
      }

      if (importerModule === undefined) {
        return;
      }
      const allowed = options.modules[importerModule];
      if (allowed === undefined) {
        context.report({ node, messageId: 'unknownModule', data: { module: importerModule } });
        return;
      }
      const targetModule = moduleOf(targetRelative);
      if (targetModule === undefined) {
        context.report({
          node,
          messageId: 'rootFile',
          data: { importer: importerModule, target: targetRelative },
        });
        return;
      }
      if (targetModule !== importerModule && !allowed.includes(targetModule)) {
        context.report({
          node,
          messageId: 'forbidden',
          data: { importer: importerModule, target: targetModule },
        });
      }
    }

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

export default moduleBoundaries;
