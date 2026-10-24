/**
 * The release workflow's steps have the credentials they need.
 *
 * Each of these is a failure that only shows up when someone dispatches a release, and some
 * of them fail after the tarball has left the runner. The step that writes the changelogs
 * had no `GITHUB_TOKEN` from the day it was written: `@changesets/changelog-github` asks the
 * GitHub API which pull request each changeset came from, and exits 1 without a token. It was
 * caught by running `changeset version` by hand before the first release, which is not a way
 * to find things.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url));

/** Each command that cannot work without a credential, and the variable that carries it. */
const CREDENTIALS = [
  ['npm run version', 'GITHUB_TOKEN'],
  ['npm run release', 'NODE_AUTH_TOKEN'],
];

/**
 * @returns {Promise<{ run: string; env: Record<string, string> }[]>}
 */
async function steps() {
  /** @type {unknown} */
  const parsed = parse(await readFile(WORKFLOW, 'utf8'));
  const workflow =
    /** @type {{ jobs: Record<string, { steps?: { run?: string; env?: Record<string, string> }[] }> }} */ (
      parsed
    );
  return Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => typeof step.run === 'string')
    .map((step) => ({ run: String(step.run), env: step.env ?? {} }));
}

/** Git writes that record an author, and so need one configured in the same step. */
const AUTHORED = [/git commit /, /git tag -a /];

describe('the release workflow', () => {
  it('configures an identity in every step that writes git history', async () => {
    const writing = (await steps()).filter((step) =>
      AUTHORED.some((pattern) => pattern.test(step.run)),
    );

    expect(writing).not.toHaveLength(0);
    for (const step of writing) {
      // A runner has no identity of its own, and git refuses with "empty ident name".
      expect(step.run).toMatch(/git config user.name/);
      expect(step.run).toMatch(/git config user.email/);
    }
  });

  it.each(CREDENTIALS)('gives %s its %s', async (command, variable) => {
    const running = (await steps()).filter((step) => step.run.includes(command));

    expect(running).not.toHaveLength(0);
    for (const step of running) {
      expect(Object.keys(step.env)).toContain(variable);
    }
  });
});
