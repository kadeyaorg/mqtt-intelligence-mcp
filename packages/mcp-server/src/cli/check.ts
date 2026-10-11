/**
 * `check`: does this configuration actually work?
 *
 * It answers the question an operator asks before wiring the server into an agent, and it
 * answers it without an MCP client: is the file valid, can each broker be reached with these
 * credentials, and does it accept the discovery subscription.
 *
 * Every broker is tested, including the ones configured to connect lazily, because "it
 * connects when first used" is precisely what one wants to find out now rather than later.
 * One broker failing does not stop the others: the report lists all of them, and the exit
 * code says whether anything failed.
 */
import type { BrokerReport, Engine, ObservationCoverage } from '@kadeya/mqtt-intel-core';
import { sanitizeError } from '@kadeya/mqtt-intel-core';
import { EXIT_CODES } from './exit-codes.js';
import type { CliOutput } from './output.js';
import { writeLines } from './output.js';

function describeTls(tls: BrokerReport['tls']): string {
  if (!tls.enabled) {
    return 'TLS off';
  }
  const parts = ['TLS on'];
  if (tls.mutual) {
    parts.push('mutual');
  }
  if (!tls.verified) {
    parts.push('certificate verification DISABLED');
  }
  return parts.join(', ');
}

function describeDiscovery(coverage: ObservationCoverage): readonly string[] {
  const lines: string[] = [];

  if (coverage.filters.length === 0) {
    lines.push('  discovery:  NONE — no discovery filter was accepted');
  } else {
    lines.push(`  discovery:  subscribed to ${coverage.filters.join(', ')}`);
  }
  for (const rejected of coverage.rejectedFilters) {
    lines.push(`  warning:    filter "${rejected.filter}" rejected (${rejected.reason})`);
  }
  // Counts are reported as they stand: check subscribes and asks, it does not wait for
  // traffic, so zero here is normal on an idle namespace and not by itself a failure.
  lines.push(
    `  observed:   ${String(coverage.topicCount)} topic(s), ${String(coverage.messageCount)} message(s) so far`,
  );
  return lines;
}

/**
 * Runs the check and writes the report. Returns the exit code.
 *
 * The configuration has already been loaded and validated by the caller: reaching this
 * function at all means the file was valid.
 */
export async function runCheck(engine: Engine, out: CliOutput): Promise<number> {
  const reports = await engine.listBrokers();
  const lines: string[] = [`Configuration: valid, ${String(reports.length)} broker(s).`, ''];
  let failures = 0;

  for (const report of reports) {
    lines.push(`${report.brokerId}  ${report.url}  ${describeTls(report.tls)}`);
    try {
      const answer = await engine.discover({ brokerId: report.brokerId });
      lines.push('  connection: ok');
      lines.push(...describeDiscovery(answer.coverage));
      if (answer.coverage.filters.length === 0) {
        failures += 1;
      }
    } catch (error) {
      failures += 1;
      const failure = sanitizeError(error, 'Could not reach the broker');
      lines.push(`  connection: FAILED — ${failure.code}: ${failure.message}`);
    }
    lines.push('');
  }

  lines.push(
    failures === 0
      ? `Result: all ${String(reports.length)} broker(s) passed.`
      : `Result: ${String(failures)} of ${String(reports.length)} broker(s) FAILED.`,
  );
  writeLines(out, lines);

  return failures === 0 ? EXIT_CODES.success : EXIT_CODES.checkFailed;
}
