/**
 * The abbreviated package name does not come back.
 *
 * The packages carried an abbreviated scope name until the day before the first release,
 * when the abbreviation was judged too close to a processor manufacturer's trademark to put
 * on a public registry. The rename touched 62 files: manifests, the CLI binary, the ESLint
 * boundary rule, the default MQTT client id, certificate common names, every example and
 * every document. One of those left behind is a name a reader copies and an install that
 * fails, so this fails the build instead.
 *
 * The forbidden string is assembled rather than written, so that this file does not trip the
 * check it defines.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', '.git', 'package-lock.json']);

/** Built from parts on purpose: see the note above. */
const ABBREVIATION = ['mqtt', 'intel'].join('-');

/** Text this check applies to. Binary files and lockfiles are not read. */
const TEXT = /\.(ts|js|mjs|cjs|json|md|ya?ml|conf|txt)$/;

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function findText(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  /** @type {string[]} */
  const found = [];
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findText(path)));
    } else if (TEXT.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

describe('the package names', () => {
  it('never use the abbreviation anywhere in the repository', async () => {
    const files = await findText(ROOT);
    /** @type {string[]} */
    const offenders = [];

    for (const path of files) {
      const text = await readFile(path, 'utf8');
      // `mqtt-intelligence` legitimately starts with the same letters: only an "intel" that
      // ends there, or is followed by a hyphen, is the old abbreviation.
      if (new RegExp(`${ABBREVIATION}(?![a-z])`).test(text)) {
        offenders.push(relative(ROOT, path));
      }
    }

    expect(offenders).toEqual([]);
  });
});
