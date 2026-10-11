/**
 * The package version, read from the manifest at runtime.
 *
 * It is read rather than compiled in so that `--version` and the version an MCP client sees
 * in the server's identity can never disagree with the installed package.
 */
import { readFile } from 'node:fs/promises';

/** Used when the manifest cannot be read: an unknown version must not stop the server. */
export const UNKNOWN_VERSION = '0.0.0-unknown';

export async function readPackageVersion(): Promise<string> {
  try {
    const text = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    const manifest: unknown = JSON.parse(text);
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
      const { version }: { version: unknown } = manifest;
      if (typeof version === 'string' && version !== '') {
        return version;
      }
    }
  } catch {
    // Falls through to the unknown version below.
  }
  return UNKNOWN_VERSION;
}
