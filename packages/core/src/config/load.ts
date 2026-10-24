/**
 * Loading a configuration: from a YAML (or JSON) file, or from the environment alone.
 *
 * The environment-only path exists for the five-minute first run:
 * `MQTT_URL=mqtt://localhost:1883 npx @kadeya/mqtt-intelligence-mcp`. It produces the same
 * validated document a file would, so there is a single code path afterwards.
 */
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type * as z from 'zod';
import { ConfigError, describeError } from '../domain/errors.js';
import type { EngineConfig, ResolveConfigOptions } from './resolve.js';
import { resolveConfig } from './resolve.js';
import type { ConfigDocument } from './schema.js';
import { configDocumentSchema, CONFIG_VERSION } from './schema.js';

/** Environment variable holding the path to the configuration file. */
export const CONFIG_PATH_ENV = 'MQTT_INTELLIGENCE_CONFIG';

/** Environment variables of the file-less quick start. */
export const QUICK_START_ENV = {
  url: 'MQTT_URL',
  username: 'MQTT_USERNAME',
  password: 'MQTT_PASSWORD',
  brokerId: 'MQTT_BROKER_ID',
} as const;

const DEFAULT_BROKER_ID = 'default';
const MAX_REPORTED_ISSUES = 12;

type Environment = Readonly<Record<string, string | undefined>>;

export interface LoadConfigOptions {
  /** Explicit path to the configuration file. Takes precedence over the environment. */
  readonly path?: string;
  /** Environment to read. Defaults to the process environment. */
  readonly env?: Environment;
  /** Base directory for relative paths when no configuration file is used. */
  readonly baseDir?: string;
}

function formatPath(path: readonly PropertyKey[]): string {
  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${String(segment)}]`;
    } else {
      formatted += formatted === '' ? String(segment) : `.${String(segment)}`;
    }
  }
  return formatted === '' ? '(root)' : formatted;
}

/** Structural view of a zod issue, including the ones nested inside a key or element. */
interface NestedIssue {
  readonly path?: readonly PropertyKey[];
  readonly message: string;
  readonly issues?: readonly NestedIssue[];
}

/**
 * Flattens nested issues, keeping the real explanation.
 *
 * A failed record key reports "Invalid key in record" and hides the actual reason one level
 * down, which would leave an operator with a correct path and no idea what is wrong.
 */
function flattenIssues(
  issues: readonly NestedIssue[],
  parentPath: readonly PropertyKey[] = [],
): { path: readonly PropertyKey[]; message: string }[] {
  const flattened: { path: readonly PropertyKey[]; message: string }[] = [];
  for (const issue of issues) {
    const path = [...parentPath, ...(issue.path ?? [])];
    if (issue.issues !== undefined && issue.issues.length > 0) {
      flattened.push(...flattenIssues(issue.issues, path));
    } else {
      flattened.push({ path, message: issue.message });
    }
  }
  return flattened;
}

function invalid(error: z.ZodError, origin: string): ConfigError {
  const issues = flattenIssues(error.issues);
  const reported = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `  - ${formatPath(issue.path)}: ${issue.message}`)
    .join('\n');
  const remaining = issues.length - MAX_REPORTED_ISSUES;
  const suffix = remaining > 0 ? `\n  …and ${String(remaining)} more problem(s).` : '';

  return new ConfigError(
    'CONFIG_INVALID',
    `Invalid configuration (${origin}):\n${reported}${suffix}`,
    { details: { origin, issueCount: issues.length } },
  );
}

/** Validates an already-parsed document and applies every default. */
export function parseConfigDocument(input: unknown, origin = 'configuration'): ConfigDocument {
  const result = configDocumentSchema.safeParse(input);
  if (!result.success) {
    throw invalid(result.error, origin);
  }
  return result.data;
}

/** Parses YAML (JSON is valid YAML) and validates the result. */
export function parseConfigText(text: string, origin: string): ConfigDocument {
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new ConfigError('CONFIG_INVALID', `Cannot parse ${origin}: ${describeError(error)}`, {
      details: { origin },
      cause: error,
    });
  }
  if (document === null || document === undefined) {
    throw new ConfigError('CONFIG_INVALID', `${origin} is empty.`, { details: { origin } });
  }
  return parseConfigDocument(document, origin);
}

/**
 * Builds the document of the file-less quick start, or `undefined` when `MQTT_URL` is unset.
 *
 * The password is referenced, never embedded, so it follows exactly the same resolution path
 * as a configuration file would.
 */
export function buildQuickStartDocument(env: Environment): ConfigDocument | undefined {
  const url = env[QUICK_START_ENV.url];
  if (url === undefined || url === '') {
    return undefined;
  }
  const username = env[QUICK_START_ENV.username];
  const password = env[QUICK_START_ENV.password];
  const brokerId = env[QUICK_START_ENV.brokerId] ?? DEFAULT_BROKER_ID;

  const auth =
    username === undefined && password === undefined
      ? undefined
      : {
          ...(username === undefined || username === '' ? {} : { username }),
          ...(password === undefined || password === ''
            ? {}
            : { password: { env: QUICK_START_ENV.password } }),
        };

  return parseConfigDocument(
    {
      version: CONFIG_VERSION,
      brokers: {
        [brokerId]: {
          url,
          ...(auth === undefined ? {} : { auth }),
        },
      },
    },
    `environment (${QUICK_START_ENV.url})`,
  );
}

export async function loadConfigFile(
  path: string,
  options: Omit<ResolveConfigOptions, 'baseDir'> = {},
): Promise<EngineConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const reason =
      error instanceof Error && 'code' in error && error.code === 'ENOENT'
        ? 'file not found'
        : describeError(error);
    throw new ConfigError('CONFIG_INVALID', `Cannot read configuration file ${path}: ${reason}.`, {
      details: { path },
      cause: error,
    });
  }
  const document = parseConfigText(text, path);
  // Relative paths inside the file are relative to the file, not to the working directory.
  return resolveConfig(document, { ...options, baseDir: dirname(path) });
}

/**
 * Loads the configuration from, in order: an explicit path, `MQTT_INTELLIGENCE_CONFIG`, or
 * the quick-start environment variables.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<EngineConfig> {
  const env = options.env ?? process.env;
  const path = options.path ?? env[CONFIG_PATH_ENV];

  if (path !== undefined && path !== '') {
    return loadConfigFile(path, { env });
  }

  const quickStart = buildQuickStartDocument(env);
  if (quickStart !== undefined) {
    return resolveConfig(quickStart, {
      env,
      ...(options.baseDir === undefined ? {} : { baseDir: options.baseDir }),
    });
  }

  throw new ConfigError(
    'CONFIG_INVALID',
    `No configuration found. Pass a file path, set ${CONFIG_PATH_ENV}, or set ${QUICK_START_ENV.url} for a single broker.`,
  );
}
