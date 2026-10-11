/**
 * Every shipped example configuration must be a configuration this release accepts.
 *
 * An example that no longer validates is worse than no example: it is copied, it fails, and
 * the reader concludes the product is broken. This suite walks `examples/` and parses each
 * file with the real schema, so a field renamed in `config/schema.ts` breaks here before it
 * breaks for a user.
 *
 * Only parsing is checked, not resolution: the examples deliberately reference environment
 * variables and certificate files that do not exist in this repository.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfigText } from '../../src/config/load.js';

const EXAMPLES = fileURLToPath(new URL('../../../../examples/', import.meta.url));

async function findYamlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findYamlFiles(path)));
    } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
      found.push(path);
    }
  }
  return found;
}

const files = await findYamlFiles(EXAMPLES);
/** Compose files are YAML too, and are not configurations. */
const configFiles = files.filter((path) => !path.endsWith('docker-compose.yml'));

describe('the example configurations', () => {
  it('are actually there, so an empty glob cannot pass this suite', () => {
    expect(configFiles.length).toBeGreaterThanOrEqual(5);
  });

  for (const path of configFiles) {
    const name = relative(EXAMPLES, path).replaceAll('\\', '/');

    it(`${name} is accepted by the schema`, async () => {
      const text = await readFile(path, 'utf8');

      const document = parseConfigText(text, name);

      expect(Object.keys(document.brokers).length).toBeGreaterThan(0);
    });

    it(`${name} contains no plain-text secret`, async () => {
      const text = await readFile(path, 'utf8');

      // The schema already refuses a password that is not a reference; this catches the
      // looser mistake of pasting one into a comment or a username.
      expect(text).not.toMatch(/(?:password|secret|token|apikey|api_key)\s*:\s*["']?[\w-]{8,}/i);
    });
  }
});
