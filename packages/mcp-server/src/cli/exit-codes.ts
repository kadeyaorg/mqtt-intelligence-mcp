/**
 * Exit codes, as part of the contract.
 *
 * A supervisor, a CI job or an MCP client launcher reads the exit code before it reads
 * anything else, so these values are public API: they are documented in `--help` and in the
 * README, and changing one is a breaking change.
 *
 * The codes separate the three failures that call for different reactions: a mistake in the
 * command line (fix the command), a mistake in the configuration (fix the file), and a
 * broker that did not answer (fix the network, the credentials or the broker).
 */
export const EXIT_CODES = {
  /** Everything asked for succeeded. `serve` also exits 0 after a graceful shutdown. */
  success: 0,
  /** An unexpected failure. The message says what happened; please report it. */
  unexpected: 1,
  /** The command line could not be understood. Nothing was started. */
  usage: 2,
  /** No configuration, or an invalid one. Nothing was connected. */
  configuration: 3,
  /** `check` ran, and at least one broker failed its connectivity or discovery test. */
  checkFailed: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
