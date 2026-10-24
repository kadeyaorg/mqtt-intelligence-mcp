/**
 * The release workflow's steps have what they need to run.
 *
 * Each of these is a failure that only shows up when someone dispatches a release, and some
 * of them fail after the packages have left the runner. The step that writes the changelogs
 * had no `GITHUB_TOKEN` from the day it was written and would have failed the first release;
 * the step that tags had no git identity and did fail it, one step after publishing. Both
 * were found by hand, which is not a way to find things.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url));

/** Git writes that record an author, and so need one configured in the same step. */
const AUTHORED = [/git commit /, /git tag -a /];

/**
 * @typedef {object} Step
 * @property {string} run
 * @property {Record<string, string>} env
 */

/**
 * @typedef {object} Job
 * @property {string} name
 * @property {Record<string, string>} permissions
 * @property {Step[]} steps
 */

/**
 * @returns {Promise<Job[]>}
 */
async function jobs() {
  /** @type {unknown} */
  const parsed = parse(await readFile(WORKFLOW, 'utf8'));
  const workflow =
    /** @type {{ jobs: Record<string, { permissions?: Record<string, string>; steps?: { run?: string; env?: Record<string, string> }[] }> }} */ (
      parsed
    );
  return Object.entries(workflow.jobs).map(([name, job]) => ({
    name,
    permissions: job.permissions ?? {},
    steps: (job.steps ?? [])
      .filter((step) => typeof step.run === 'string')
      .map((step) => ({ run: String(step.run), env: step.env ?? {} })),
  }));
}

/**
 * @returns {Promise<Step[]>}
 */
async function steps() {
  return (await jobs()).flatMap((job) => job.steps);
}

describe('the release workflow', () => {
  it('gives the changelog step a GitHub token', async () => {
    // @changesets/changelog-github asks the API which pull request each changeset came from
    // and exits 1 without a token, rather than writing a plainer changelog.
    const writing = (await steps()).filter((step) => step.run.includes('npm run version'));

    expect(writing).not.toHaveLength(0);
    for (const step of writing) {
      expect(Object.keys(step.env)).toContain('GITHUB_TOKEN');
    }
  });

  it('publishes with an OIDC identity and no stored credential', async () => {
    // Both packages are configured on npmjs.com to accept only a trusted publisher, so the
    // id-token permission is the entire credential: without it there is nothing to exchange.
    const publishing = (await jobs()).filter((job) =>
      job.steps.some((step) => step.run.includes('npm run release')),
    );

    expect(publishing).not.toHaveLength(0);
    for (const job of publishing) {
      expect(job.permissions['id-token']).toBe('write');
    }
  });

  it('never reaches for a publish token again', async () => {
    // A token cannot publish these packages any more, so one reappearing here would be a
    // secret that grants nothing and a release that fails for a reason nobody expects.
    const reaching = (await steps()).filter((step) =>
      Object.keys(step.env).some((variable) => /NODE_AUTH_TOKEN|NPM_TOKEN/.test(variable)),
    );

    expect(reaching.map((step) => step.run.split('\n')[0])).toEqual([]);
  });

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
});
