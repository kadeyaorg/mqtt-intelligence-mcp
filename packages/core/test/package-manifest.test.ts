import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/** Runtime dependencies the core may ever declare (docs/proposal/03-architecture.md §4). */
const ALLOWED_RUNTIME_DEPENDENCIES = new Set(['mqtt', 'yaml', 'zod']);

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

describe('core package manifest', () => {
  it('declares only the runtime dependencies allowed by the architecture', async () => {
    const manifest = await readManifest();
    const runtime = [
      ...dependencyNames(manifest, 'dependencies'),
      ...dependencyNames(manifest, 'peerDependencies'),
      ...dependencyNames(manifest, 'optionalDependencies'),
    ];

    expect(runtime.filter((name) => !ALLOWED_RUNTIME_DEPENDENCIES.has(name))).toEqual([]);
  });

  it('never depends on MCP packages (ADR-0003)', async () => {
    const manifest = await readManifest();
    const all = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'];
    const names = all.flatMap((field) => dependencyNames(manifest, field));

    expect(names.filter((name) => name.startsWith('@modelcontextprotocol/'))).toEqual([]);
  });

  it('is an ES module targeting the supported Node.js LTS lines (ADR-0001)', async () => {
    const manifest = await readManifest();

    expect(manifest['type']).toBe('module');
    expect(manifest['engines']).toEqual({ node: '^22.12.0 || >=24.0.0' });
  });

  it('cannot be published before the npm organisation is confirmed (ADR-0002)', async () => {
    const manifest = await readManifest();

    expect(manifest['private']).toBe(true);
  });
});
