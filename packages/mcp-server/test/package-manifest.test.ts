import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** Runtime dependencies the MCP package may ever declare (docs/proposal/03-architecture.md §4). */
const ALLOWED_RUNTIME_DEPENDENCIES = new Set([
  '@kadeya/mqtt-intelligence-core',
  '@modelcontextprotocol/server',
  'zod',
]);

async function readManifest(): Promise<Record<string, unknown>> {
  const text = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const manifest: unknown = JSON.parse(text);
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new TypeError('package.json must contain a JSON object');
  }
  return manifest as Record<string, unknown>;
}

function dependencyNames(manifest: Record<string, unknown>, field: string): string[] {
  const value = manifest[field];
  return typeof value === 'object' && value !== null ? Object.keys(value) : [];
}

describe('mcp-server package manifest', () => {
  it('declares only the runtime dependencies allowed by the architecture', async () => {
    const manifest = await readManifest();
    const runtime = [
      ...dependencyNames(manifest, 'dependencies'),
      ...dependencyNames(manifest, 'peerDependencies'),
      ...dependencyNames(manifest, 'optionalDependencies'),
    ];

    expect(runtime.filter((name) => !ALLOWED_RUNTIME_DEPENDENCIES.has(name))).toEqual([]);
  });

  it('does not depend on mqtt.js directly (ADR-0006)', async () => {
    const manifest = await readManifest();

    expect(dependencyNames(manifest, 'dependencies')).not.toContain('mqtt');
  });

  it('is publishable, and ships only what it declares (ADR-0002)', async () => {
    const manifest = await readManifest();

    // The safety catch came off for the first release. What stands in its place is the
    // allowlist: an opt-in `files` list cannot quietly start shipping a stray file because
    // somebody dropped one next to the sources. `src` is deliberate — the source maps point
    // at it, and a reader should be able to follow them.
    expect(manifest['private']).toBe(false);
    expect(manifest['files']).toEqual([
      'dist',
      'src',
      '!**/*.tsbuildinfo',
      'LICENSE',
      'NOTICE',
      'CHANGELOG.md',
    ]);
  });
});

describe('workspace wiring', () => {
  it('resolves the core package through its public entry point', async () => {
    const core: unknown = await import('@kadeya/mqtt-intelligence-core');

    expect(core).toBeTypeOf('object');
  });
});

describe('the command-line entry point', () => {
  it('is published as a single bin, so "npx @kadeya/mqtt-intelligence-mcp" resolves it', async () => {
    const manifest = await readManifest();

    expect(manifest['bin']).toEqual({ 'mqtt-intelligence-mcp': 'dist/cli/bin.js' });
  });
});
