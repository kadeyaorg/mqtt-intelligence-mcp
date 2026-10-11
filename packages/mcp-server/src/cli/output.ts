/**
 * Where the CLI writes.
 *
 * Everything the CLI says goes to **stderr**, including `--help` and `--version`. That is
 * unusual for a command-line tool and deliberate: the same binary serves MCP over stdio, so
 * stdout carries protocol frames and nothing else (ADR-0012). A line of help text on stdout
 * would be a parse error in the client rather than a readable message, whereas stderr is
 * exactly where MCP clients collect a server's diagnostics.
 *
 * It is an interface so that tests can read what was written without spawning a process.
 */
export interface CliOutput {
  write(text: string): void;
}

export const stderrOutput: CliOutput = {
  write(text: string): void {
    process.stderr.write(text);
  },
};

/** Writes a block of text as whole lines, so partial lines never interleave. */
export function writeLines(out: CliOutput, lines: readonly string[]): void {
  out.write(`${lines.join('\n')}\n`);
}
