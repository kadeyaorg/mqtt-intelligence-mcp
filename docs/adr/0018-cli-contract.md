# ADR-0018 — The CLI writes to stderr; exit codes are part of the contract

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The published package carries one `bin`, and that binary has two audiences that never meet.

An **MCP client** starts it with no arguments, speaks JSON-RPC over stdin and stdout, and
stops it by closing the pipe. For that audience stdout is the protocol (ADR-0012): a single
line of anything else is a parse error, not a message. When such a server fails to start, the
only thing the user sees is whatever the client collected from stderr.

An **operator** runs `check` by hand, or from a container entry point, or from a CI job
before wiring the server into an agent. That audience reads the exit code first, and the
report second.

The two audiences share one process, so a decision is needed about which stream carries what,
and about what the exit codes mean.

## Decision

1. **stdout carries MCP protocol frames and nothing else.** Everything the CLI itself says —
   the report from `check`, `--help`, `--version`, every log line — goes to stderr. This is
   deliberately not the Unix convention for `--help` and `--version`, and is the reason the
   ESLint ban on `process.stdout` in product code has no exception.
2. **The exit codes are public API**, documented in `--help`, in the README and in
   `cli/exit-codes.ts`, and changing one is a breaking change:

   | Code | Meaning                                                           |
   | ---- | ----------------------------------------------------------------- |
   | 0    | Success. `serve` also exits 0 after a graceful shutdown.          |
   | 1    | Unexpected failure.                                               |
   | 2    | The command line could not be understood. Nothing was started.    |
   | 3    | Missing or invalid configuration. Nothing was connected.          |
   | 4    | `check` ran and at least one broker failed its connectivity test. |

   Codes 2, 3 and 4 separate the three failures that call for different reactions: fix the
   command, fix the configuration, fix the broker or the network.

3. **`serve` is the default command**, because that is how an MCP client launches the binary:
   with no arguments at all.
4. **Arguments are parsed with `node:util`'s `parseArgs`**, and anything unrecognised is a
   usage error rather than a guess. A server started with a typo in its arguments must fail
   loudly instead of running with silently different settings.
5. **`serve` shuts down on SIGINT, SIGTERM or the end of its standard input**, and each stage
   of that shutdown has a deadline. A server that cannot stop is worse than one that stops
   untidily, so an overrunning stage is reported and abandoned.
6. **`check` tests every configured broker**, including those configured to connect lazily,
   and reports all of them before exiting. It reports what the broker _accepted_: a broker
   may accept a subscription and then deliver nothing on it, which no client can detect, so
   broker ACLs remain the authoritative control (ADR-0004).

## Consequences

- An MCP client that mis-launches the server gets a readable diagnostic where it already
  looks for one, instead of a JSON parse error.
- `mqtt-intelligence-mcp --version > version.txt` writes an empty file. This is the known cost of
  decision 1; the version is also available from `package.json` and from the MCP server
  identity returned to a client.
- Supervisors, container health checks and CI jobs can branch on the exit code without
  parsing output.
- `runCli` takes its arguments, environment and output as parameters and never calls
  `process.exit`, so every outcome above is tested without a subprocess. The `bin` entry is
  the only file that touches the process, and spawn tests cover it end to end.

## Alternatives considered

- **Help and version on stdout, like every other CLI.** Rejected: the same binary is a stdio
  server, and the failure mode we optimise for is a misconfigured MCP client, where stdout is
  read by a JSON-RPC parser and stderr is read by a human.
- **A separate binary for `check`.** Rejected: two entry points to install, document and keep
  in step, for one behaviour that differs only in what it does after loading the same
  configuration.
- **Exit 1 for everything that failed.** Rejected: it forces the operator to read and parse
  the output to learn whether the problem is their command line, their file or their broker.
- **A `--wait` flag on `check`.** Deferred. It would make `check` a traffic observer as well
  as a connectivity test, and the V0.1 flag surface is `--config`, `--help` and `--version`.
