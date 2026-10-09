// @ts-check
/**
 * Points git at the versioned hooks in `.githooks` (see .github/rulesets/README.md).
 *
 * Run by the `prepare` script on `npm install`. It must never break an install: it does
 * nothing outside a git working copy, in CI, or when git is unavailable.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

if (process.env['CI'] === undefined && existsSync(join(repositoryRoot, '.git'))) {
  execFile('git', ['-C', repositoryRoot, 'config', 'core.hooksPath', '.githooks'], (error) => {
    if (error) {
      process.stderr.write(`setup-git-hooks: skipped (${error.message})\n`);
    }
  });
}
