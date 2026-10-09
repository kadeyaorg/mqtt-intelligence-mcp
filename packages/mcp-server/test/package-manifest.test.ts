import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** Runtime dependencies the MCP package may ever declare (docs/proposal/03-architecture.md §4). */
const ALLOWED_RUNTIME_DEPENDENCIES = new Set([
  '@kadeya/mqtt-intel-core',
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

  it('cannot be published before the npm organisation is confirmed (ADR-0002)', async () => {
    const manifest = await readManifest();

    expect(manifest['private']).toBe(true);
  });
});

describe('workspace wiring', () => {
  it('resolves the core package through its public entry point', async () => {
    const core: unknown = await import('@kadeya/mqtt-intel-core');

    expect(core).toBeTypeOf('object');
  });
});
