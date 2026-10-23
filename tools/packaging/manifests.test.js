/**
 * The publishing contract of the packages that go to npm.
 *
 * Every assertion here corresponds to a way the registry rejects a publish, and the registry
 * rejects it halfway through: `changeset publish` walks the packages in order, so a manifest
 * mistake can leave one package released and the other not. These are cheap to check long
 * before the release workflow reaches the network.
 *
 * The npm organisation and the repository visibility are not checked here. They are not in
 * this repository, and a test that reaches for the network fails for reasons that have
 * nothing to do with the change being tested — the release workflow checks those, once, where
 * it can act on the answer.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url);

/** The packages that are meant to reach npm. The example simulator is not one of them. */
const PUBLISHABLE = ['packages/core', 'packages/mcp-server'];

const REPOSITORY_URL = 'git+https://github.com/kadeyaorg/mqtt-intelligence-mcp.git';

/**
 * @typedef {object} Manifest
 * @property {string} name
 * @property {boolean} [private]
 * @property {{ access?: string; provenance?: boolean }} [publishConfig]
 * @property {{ type?: string; url?: string; directory?: string }} [repository]
 */

/**
 * @param {string} directory
 * @returns {Promise<Manifest>}
 */
async function manifestOf(directory) {
  const path = fileURLToPath(new URL(`${directory}/package.json`, ROOT));
  /** @type {unknown} */
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return /** @type {Manifest} */ (parsed);
}

describe('the publishable manifests', () => {
  for (const directory of PUBLISHABLE) {
    describe(directory, () => {
      it('asks for a public, scoped package', async () => {
        const manifest = await manifestOf(directory);
        expect(manifest.name).toMatch(/^@kadeya\//);
        expect(manifest.publishConfig).toMatchObject({ access: 'public' });
      });

      it('points provenance at the repository it is actually built from', async () => {
        // npm verifies the attestation against `repository` and refuses the publish with a
        // 422 when the URL is missing or does not match the workflow's own repository. The
        // `directory` is what makes the attestation point at this package rather than at the
        // workspace root.
        const manifest = await manifestOf(directory);
        expect(manifest.publishConfig).toMatchObject({ provenance: true });
        expect(manifest.repository).toEqual({
          type: 'git',
          url: REPOSITORY_URL,
          directory,
        });
      });
    });
  }

  it('arms or disarms every package together', async () => {
    // `private` is the release safety catch (ADR-0002). Flipping one and not the other does
    // not half-publish a release: it publishes one package, whose dependency on the other is
    // unresolvable for everybody who installs it.
    const manifests = await Promise.all(PUBLISHABLE.map(manifestOf));
    expect([...new Set(manifests.map((manifest) => manifest.private))]).toHaveLength(1);
  });
});
