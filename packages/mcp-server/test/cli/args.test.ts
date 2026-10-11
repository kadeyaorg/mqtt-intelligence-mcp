/**
 * Command-line parsing.
 *
 * A server launched by an MCP client with a typo in its arguments must fail loudly rather
 * than start with silently different settings, so every one of these cases is a usage error
 * and not a guess.
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/cli/args.js';

describe('parseCliArgs', () => {
  it('serves by default, which is how a client launches the binary', () => {
    expect(parseCliArgs([])).toEqual({ ok: true, command: { name: 'serve' } });
  });

  it('accepts the two commands', () => {
    expect(parseCliArgs(['serve'])).toEqual({ ok: true, command: { name: 'serve' } });
    expect(parseCliArgs(['check'])).toEqual({ ok: true, command: { name: 'check' } });
  });

  it('takes a configuration path, long or short', () => {
    expect(parseCliArgs(['--config', 'a.yaml'])).toEqual({
      ok: true,
      command: { name: 'serve', configPath: 'a.yaml' },
    });
    expect(parseCliArgs(['check', '-c', 'a.yaml'])).toEqual({
      ok: true,
      command: { name: 'check', configPath: 'a.yaml' },
    });
  });

  it('answers help and version whatever else is on the line', () => {
    expect(parseCliArgs(['check', '--help'])).toEqual({ ok: true, command: { name: 'help' } });
    expect(parseCliArgs(['-h'])).toEqual({ ok: true, command: { name: 'help' } });
    expect(parseCliArgs(['serve', '--version'])).toEqual({
      ok: true,
      command: { name: 'version' },
    });
    expect(parseCliArgs(['-v'])).toEqual({ ok: true, command: { name: 'version' } });
  });

  it('refuses an unknown option', () => {
    const result = parseCliArgs(['--verbose']);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('--verbose');
  });

  it('refuses an unknown command, and names the known ones', () => {
    const result = parseCliArgs(['publish']);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('serve, check');
  });

  it('refuses several commands rather than picking one', () => {
    const result = parseCliArgs(['serve', 'check']);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('serve check');
  });

  it('refuses an empty configuration path', () => {
    const result = parseCliArgs(['--config=']);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('--config');
  });
});
