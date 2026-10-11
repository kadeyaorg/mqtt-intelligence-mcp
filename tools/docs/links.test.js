/**
 * Every relative link in the documentation points at something that exists.
 *
 * Documentation rots quietly: a file moves, six links go stale, and nobody notices until a
 * reader does. This walks every Markdown file in the repository and resolves each relative
 * link, so a rename breaks the build instead of the reader's afternoon.
 *
 * External links are not checked. A test that depends on the internet is a test that fails
 * for reasons that have nothing to do with the change being tested.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.git']);

/** Markdown inline links: the target is everything up to a space (a title) or the paren. */
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function findMarkdown(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  /** @type {string[]} */
  const found = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...(await findMarkdown(path)));
      }
    } else if (entry.name.endsWith('.md')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * @param {string} target
 * @returns {boolean}
 */
function isExternal(target) {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:') ||
    target.startsWith('#')
  );
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const files = await findMarkdown(ROOT);

describe('documentation links', () => {
  it('finds the documentation at all, so an empty walk cannot pass', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('all resolve to something that exists', async () => {
    /** @type {string[]} */
    const broken = [];

    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(LINK)) {
        const target = match[1];
        if (target === undefined || isExternal(target)) {
          continue;
        }
        // A fragment is a position inside the target, not part of its path.
        const path = target.split('#')[0];
        if (path === undefined || path === '') {
          continue;
        }
        const resolved = resolve(dirname(file), decodeURIComponent(path));
        if (!(await exists(resolved))) {
          broken.push(`${relative(ROOT, file).replaceAll('\\', '/')} -> ${target}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });
});
