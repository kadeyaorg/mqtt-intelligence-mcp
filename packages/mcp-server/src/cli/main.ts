/**
 * The command line, as one function returning an exit code.
 *
 * `runCli` takes its arguments, its environment and its output as parameters and never calls
 * `process.exit`, so the whole flow — parsing, loading the configuration, running a command,
 * failing — can be exercised in a test without a subprocess. The `bin` entry is the only
 * place that touches the process itself.
 *
 * Failures are classified before anything is started: a mistake in the command line and a
 * mistake in the configuration are different problems with different exit codes, and both
 * are reported before a single socket is opened.
 */
import type { Engine, EngineConfig, Logger } from '@kadeya/mqtt-intel-core';
import { createEngine, createLogger, loadConfig, sanitizeError } from '@kadeya/mqtt-intel-core';
import { parseCliArgs } from './args.js';
import { runCheck } from './check.js';
import { closeWithDeadline } from './close.js';
import { EXIT_CODES } from './exit-codes.js';
import { BINARY_NAME, helpText } from './help.js';
import type { CliOutput } from './output.js';
import { writeLines } from './output.js';
import { runServe } from './serve.js';
import { readPackageVersion } from './version.js';

export interface CliContext {
  /** Arguments after the executable and the script, as `process.argv.slice(2)` gives them. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: CliOutput;
}

function createCliLogger(config: EngineConfig): Logger {
  return createLogger({
    level: config.logging.level,
    format: config.logging.format,
    redactKeys: config.security.redaction.jsonKeys,
  });
}

export async function runCli(context: CliContext): Promise<number> {
  const version = await readPackageVersion();
  const parsed = parseCliArgs(context.argv);

  if (!parsed.ok) {
    writeLines(context.out, [parsed.message, `Run "${BINARY_NAME} --help" for usage.`]);
    return EXIT_CODES.usage;
  }

  const { command } = parsed;
  if (command.name === 'help') {
    writeLines(context.out, helpText(version));
    return EXIT_CODES.success;
  }
  if (command.name === 'version') {
    writeLines(context.out, [version]);
    return EXIT_CODES.success;
  }

  let config: EngineConfig;
  try {
    config = await loadConfig({
      env: context.env,
      ...(command.configPath === undefined ? {} : { path: command.configPath }),
    });
  } catch (error) {
    // Anything that stops a configuration being obtained is a configuration failure, whether
    // the file is missing, unreadable or invalid.
    const failure = sanitizeError(error, 'Could not load the configuration');
    writeLines(context.out, [failure.message]);
    return EXIT_CODES.configuration;
  }

  const logger = createCliLogger(config);
  const engine: Engine = createEngine(config, { logger });
  try {
    return command.name === 'check'
      ? await runCheck(engine, context.out)
      : await runServe(engine, logger, version);
  } catch (error) {
    const failure = sanitizeError(error, `The "${command.name}" command failed`);
    writeLines(context.out, [`${failure.code}: ${failure.message}`]);
    logger.error('Command failed', { command: command.name, code: failure.code });
    return EXIT_CODES.unexpected;
  } finally {
    // One place closes the engine, for every command and every outcome, so no run can leave
    // a broker connection behind.
    await closeWithDeadline('engine', engine.close(), logger);
  }
}
