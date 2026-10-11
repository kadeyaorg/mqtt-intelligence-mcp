#!/usr/bin/env node
/**
 * The `bin` entry: the only file that touches the process.
 *
 * It sets `process.exitCode` instead of calling `process.exit`, so buffered stderr reaches a
 * pipe before the process goes away. The unreferenced timer that follows is the safety net:
 * it does not keep the event loop alive, so a clean shutdown exits immediately, but if
 * something did survive the shutdown the process still leaves rather than hanging in a
 * client's process table.
 */
import { runCli } from './main.js';
import { stderrOutput } from './output.js';

const FORCED_EXIT_DELAY_MS = 2_000;

const code = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  out: stderrOutput,
});

process.exitCode = code;
setTimeout(() => {
  process.exit(code);
}, FORCED_EXIT_DELAY_MS).unref();
