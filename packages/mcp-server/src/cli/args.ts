/**
 * Parsing the command line with `node:util`'s `parseArgs`.
 *
 * No argument-parsing dependency: the surface is two commands and three flags, and a
 * dependency here would be a dependency in every installation of the server.
 *
 * Anything unrecognised is a usage error rather than a guess. A server launched by an MCP
 * client with a typo in its arguments should fail immediately and say so, not start with
 * silently different settings.
 */
import { parseArgs } from 'node:util';
import { describeError } from '@kadeya/mqtt-intelligence-core';

export type CommandName = 'serve' | 'check' | 'help' | 'version';

export interface ParsedCommand {
  readonly name: CommandName;
  /** Explicit `--config` path, when given. */
  readonly configPath?: string;
}

export type ParseResult =
  | { readonly ok: true; readonly command: ParsedCommand }
  | { readonly ok: false; readonly message: string };

const COMMANDS = ['serve', 'check'] as const;

function isCommand(value: string): value is 'serve' | 'check' {
  return (COMMANDS as readonly string[]).includes(value);
}

export function parseCliArgs(argv: readonly string[]): ParseResult {
  let values: { config?: string; help?: boolean; version?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: {
        config: { type: 'string', short: 'c' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }

  // Asking for help or the version is answered whatever else is on the line, as everywhere.
  if (values.help === true) {
    return { ok: true, command: { name: 'help' } };
  }
  if (values.version === true) {
    return { ok: true, command: { name: 'version' } };
  }

  if (values.config !== undefined && values.config === '') {
    return { ok: false, message: 'Option --config needs a path to a configuration file.' };
  }

  if (positionals.length > 1) {
    return {
      ok: false,
      message: `Expected one command, got ${String(positionals.length)}: ${positionals.join(' ')}.`,
    };
  }

  const [positional] = positionals;
  if (positional !== undefined && !isCommand(positional)) {
    return {
      ok: false,
      message: `Unknown command "${positional}". Known commands: ${COMMANDS.join(', ')}.`,
    };
  }

  return {
    ok: true,
    command: {
      // Serving is the default, because that is how an MCP client launches the binary: with
      // no arguments at all.
      name: positional ?? 'serve',
      ...(values.config === undefined ? {} : { configPath: values.config }),
    },
  };
}
